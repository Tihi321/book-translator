import { ProviderLimiter } from './limiter'
import { computeCost, isPaidModel } from './registry'
import type { ModelInfo, ModelRegistry } from './registry'
import { emptyUsage, isAbortError, ProviderError } from './types'
import type { ChatMessage, RequestMeta, Usage } from './types'

export interface RoutedRequest {
  messages: ChatMessage[]
  schema?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  meta?: RequestMeta
  /** Extra JSON fields merged into the request body, on top of the model's own `extra_body`. */
  extraBody?: Record<string, unknown>
}

/** A model reference: `provider/model` or an already resolved model. */
export type ModelRef = string | ModelInfo

export interface RoutedResult {
  text: string
  model: ModelInfo
  usage: Usage
  costUsd: number
  ms: number
  /** Number of attempts made (1 = first try worked). */
  attempts: number
}

export type RoutedEvent =
  | { type: 'attempt'; model: ModelInfo; attempt: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; model: ModelInfo; usage: Usage; costUsd: number; ms: number }

export interface RouterOptions {
  /** Retries on the same model for retryable errors before falling back. Default 2. */
  retries?: number
  /** First backoff in ms. Doubled each retry. Default 1000. */
  backoffMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      },
      { once: true }
    )
  })

/**
 * Calls an explicit, ordered list of models (`provider/model` refs) with fallback: retries with backoff on 429, 5xx
 * and timeouts, then the next model in the list. Respects provider concurrency and rpm limits.
 * The done event carries usage and costUsd so callers can sum the spend.
 */
export class ModelRouter {
  readonly limiter: ProviderLimiter
  private readonly opts: Required<Omit<RouterOptions, 'now'>>

  constructor(
    readonly registry: ModelRegistry,
    opts: RouterOptions = {},
    limiter?: ProviderLimiter
  ) {
    this.limiter = limiter ?? new ProviderLimiter(opts.now)
    this.opts = { retries: opts.retries ?? 2, backoffMs: opts.backoffMs ?? 1000, sleep: opts.sleep ?? defaultSleep }
  }

  /** Resolves refs to models, in order, without duplicates. Unknown, embedding and unavailable models are dropped. */
  resolve(refs: readonly ModelRef[]): ModelInfo[] {
    const seen = new Set<string>()
    const list: ModelInfo[] = []
    for (const r of refs) {
      const ref = typeof r === 'string' ? r : r.ref
      if (seen.has(ref)) continue
      seen.add(ref)
      const m = typeof r === 'string' ? this.registry.getModel(r) : r
      if (m && m.provider.available && m.provider.client && !m.embedding) list.push(m)
    }
    return list
  }

  /** Streams to the end and returns the whole reply. `onDelta` sees the text of the current attempt (reset on `onAttempt`). */
  async complete(
    refs: readonly ModelRef[],
    req: RoutedRequest,
    hooks: { onDelta?: (text: string) => void; onAttempt?: (model: ModelInfo, attempt: number) => void } = {},
    held?: ReadonlySet<string>
  ): Promise<RoutedResult> {
    let text = ''
    let attempts = 0
    for await (const ev of this.chat(refs, req, held)) {
      if (ev.type === 'attempt') {
        text = ''
        attempts = ev.attempt
        hooks.onAttempt?.(ev.model, ev.attempt)
      } else if (ev.type === 'delta') {
        text += ev.text
        hooks.onDelta?.(ev.text)
      } else return { text, model: ev.model, usage: ev.usage, costUsd: ev.costUsd, ms: ev.ms, attempts }
    }
    throw new ProviderError('the model returned no result')
  }

  /**
   * Streams a reply, falling back through `refs`. `held` are providers whose slot the caller already holds.
   * After a failed attempt the consumer sees a new `attempt` event and should drop the text so far.
   */
  async *chat(refs: readonly ModelRef[], req: RoutedRequest, held: ReadonlySet<string> = new Set()): AsyncGenerator<RoutedEvent, void, void> {
    const models = this.resolve(refs)
    if (models.length === 0) throw new ProviderError(`no available model in: ${refs.map((r) => (typeof r === 'string' ? r : r.ref)).join(', ') || '(empty list)'}`)
    let lastError: unknown
    let attempts = 0
    for (const model of models) {
      for (let retry = 0; retry <= this.opts.retries; retry++) {
        if (req.signal?.aborted) throw abort()
        const paid = isPaidModel(model)
        const provider = model.provider
        const holdsSlot = held.has(provider.id)
        let acquired = false
        const started = Date.now()
        try {
          if (!holdsSlot) {
            await this.limiter.acquire(provider, req.signal)
            acquired = true
          }
          const wait = this.limiter.rpmWaitMs(provider)
          if (wait > 0) await this.opts.sleep(wait, req.signal)
          this.limiter.noteRequest(provider)
          attempts++
          yield { type: 'attempt', model, attempt: attempts }
          let usage = emptyUsage()
          for await (const ev of provider.client!.chat({
            model: model.id,
            messages: req.messages,
            schema: req.schema,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            signal: req.signal,
            extraBody: req.extraBody ? { ...model.extraBody, ...req.extraBody } : model.extraBody,
            meta: req.meta
          })) {
            if (ev.type === 'delta') yield { type: 'delta', text: ev.text }
            else usage = ev.usage
          }
          const costUsd = paid ? computeCost(model, usage) : 0
          const ms = Date.now() - started
          yield { type: 'done', model, usage, costUsd, ms }
          return
        } catch (err) {
          if (isAbortError(err) || req.signal?.aborted) throw err
          lastError = err
          const retryable = err instanceof ProviderError && err.retryable
          if (!retryable || retry === this.opts.retries) break
          const delay = (err as ProviderError).retryAfterMs ?? this.opts.backoffMs * 2 ** retry
          await this.opts.sleep(delay, req.signal)
        } finally {
          if (acquired) this.limiter.release(provider)
        }
      }
    }
    throw lastError instanceof Error ? lastError : new ProviderError('all models failed')
  }
}

function abort(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}
