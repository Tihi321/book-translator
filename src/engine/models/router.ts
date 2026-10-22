import { ProviderLimiter } from './limiter'
import { computeCost, isPaidModel } from './registry'
import type { ModelInfo, ModelRegistry, ProviderInfo } from './registry'
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
  /** Called when a request finds a server not running and marks it down for every project. */
  onProviderDown?: (p: ProviderInfo) => void
  /** Called when a provider's daily limit is used up (its `rpd`, or the provider said so): its work uses the next model until midnight UTC. */
  onProviderDayFull?: (p: ProviderInfo) => void
  private readonly opts: Required<Omit<RouterOptions, 'now'>>

  constructor(
    readonly registry: ModelRegistry,
    opts: RouterOptions = {},
    limiter?: ProviderLimiter
  ) {
    this.limiter = limiter ?? new ProviderLimiter(opts.now)
    this.opts = { retries: opts.retries ?? 2, backoffMs: opts.backoffMs ?? 1000, sleep: opts.sleep ?? defaultSleep }
  }

  /** The provider can take requests now: its server is up and its daily limit isn't used up. */
  private usable(p: ProviderInfo): boolean {
    return !p.down && !this.limiter.dayFull(p)
  }

  /**
   * Resolves refs to models, in order, without duplicates. Aliases (`paid`, `strata`, `lmstudio`) become their default model and the
   * list is sorted by the group order. Unknown, embedding and unavailable models are dropped, and so are servers that are down
   * and providers whose daily limit is used up, unless nothing else is left.
   */
  resolve(refs: readonly ModelRef[]): ModelInfo[] {
    const strs = refs.map((r) => (typeof r === 'string' ? r : r.ref))
    const objs = new Map<string, ModelInfo>()
    for (const r of refs) if (typeof r !== 'string') objs.set(r.ref, r)
    const seen = new Set<string>()
    let list: ModelInfo[] = []
    for (const alias of this.registry.orderRefs(strs)) {
      const ref = this.registry.resolve(alias)
      if (seen.has(ref)) continue
      seen.add(ref)
      const m = objs.get(ref) ?? this.registry.getModel(ref)
      if (m && m.provider.available && m.provider.client && !m.embedding) list.push(m)
    }
    const up = list.filter((m) => this.usable(m.provider))
    if (up.length > 0) list = up
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
    const failures: string[] = []
    const generation = this.registry.generation
    for (const [i, model] of models.entries()) {
      // a server that went down, or a daily limit used up, after the call started: skip it while a later model can answer
      if (!this.usable(model.provider) && models.slice(i + 1).some((m) => this.usable(m.provider))) continue
      // the model as the attempts use it: taken afresh from the registry once a config reload happened since the objects were resolved
      let active = model
      let seenGeneration = generation
      for (let retry = 0; retry <= this.opts.retries; retry++) {
        if (req.signal?.aborted) throw abort()
        let provider = active.provider
        const holdsSlot = held.has(provider.id)
        let acquired = false
        const started = Date.now()
        try {
          if (!holdsSlot) {
            const id = provider.id
            await this.limiter.acquire(provider, req.signal, () => this.registry.providers.get(id))
            acquired = true
          }
          const wait = this.limiter.rpmWaitMs(provider)
          if (wait > 0) await this.opts.sleep(wait, req.signal)
          if (seenGeneration !== this.registry.generation) {
            seenGeneration = this.registry.generation
            const fresh = this.registry.getModel(model.ref)
            if (!fresh || !fresh.provider.available || !fresh.provider.client) {
              const msg = `${model.ref}: removed or turned off in the config during the call`
              lastError = new ProviderError(msg)
              failures.push(msg)
              break
            }
            active = fresh
            provider = fresh.provider
          }
          this.limiter.noteRequest(provider)
          attempts++
          yield { type: 'attempt', model: active, attempt: attempts }
          let usage = emptyUsage()
          for await (const ev of provider.client!.chat({
            model: active.id,
            messages: req.messages,
            schema: req.schema,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            signal: req.signal,
            extraBody: req.extraBody ? { ...active.extraBody, ...req.extraBody } : active.extraBody,
            meta: req.meta
          })) {
            if (ev.type === 'delta') yield { type: 'delta', text: ev.text }
            else usage = ev.usage
          }
          const costUsd = isPaidModel(active) ? computeCost(active, usage) : 0
          const ms = Date.now() - started
          yield { type: 'done', model: active, usage, costUsd, ms }
          return
        } catch (err) {
          if (isAbortError(err) || req.signal?.aborted) throw err
          lastError = err
          const msg = err instanceof Error ? err.message : String(err)
          // nothing listens there (Strata not started): mark it down for everyone and go to the next model without retries
          if (err instanceof ProviderError && err.unreachable && provider.concurrencyAuto) {
            if (this.registry.markDown(provider)) this.onProviderDown?.(provider)
            failures.push(`${model.ref}: ${msg}`)
            break
          }
          // the provider's daily limit is used up (OpenRouter's free-models-per-day): retrying is no use until midnight UTC
          if (isDailyLimitError(err)) {
            if (this.limiter.markDayFull(provider)) this.onProviderDayFull?.(provider)
            failures.push(`${model.ref}: ${msg}`)
            break
          }
          // a request too big for this model fails the same way every time: go straight to the next model
          const retryable = err instanceof ProviderError && err.retryable && !isContextError(err)
          if (!retryable || retry === this.opts.retries) {
            failures.push(`${model.ref}: ${msg}`)
            break
          }
          const delay = (err as ProviderError).retryAfterMs ?? this.opts.backoffMs * 2 ** retry
          await this.opts.sleep(delay, req.signal)
        } finally {
          if (acquired) this.limiter.release(provider)
        }
      }
    }
    // with more than one model, say why each one failed: the last error alone hides the real cause
    if (failures.length > 1) throw new ProviderError(`all models failed. ${failures.map((f) => f.slice(0, 400)).join(' | ')}`)
    throw lastError instanceof Error ? lastError : new ProviderError('all models failed')
  }
}

/** A 429 that says a daily request limit is used up (OpenRouter: `free-models-per-day`), not a per-minute one. */
export function isDailyLimitError(err: unknown): boolean {
  if (!(err instanceof ProviderError) || err.status !== 429) return false
  return /per[-_ ]day|daily/i.test(err.message)
}

/** The request is larger than the model's context window, or the model ran out of tokens before answering. */
export function isContextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /exceed_context_size|exceeds the available context|context (size|length|window)|maximum context|n_ctx|token limit without an answer/i.test(msg)
}

function abort(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}
