import { estimateTokens } from './types'
import type { ChatEvent, ChatRequest, ProviderClient, RequestMeta, Usage } from './types'

/** What a responder returns. A plain string is the reply text. */
export type MockReply =
  | string
  | {
      text: string
      usage?: Partial<Usage>
      /** Delay between chunks in ms. */
      chunkDelayMs?: number
      /** Number of chunks to split the text in. */
      chunks?: number
    }

export type MockResponder = (req: ChatRequest) => MockReply | Promise<MockReply>

interface Rule {
  role?: string
  task?: string
  responder: MockResponder
}

export interface MockOptions {
  /** Default delay between chunks. */
  chunkDelayMs?: number
  chunks?: number
  /** Fake embedding size. */
  embeddingDim?: number
}

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A scripted provider for tests. Tests register responders keyed by role and/or task (or any function of the request).
 * The last matching rule wins. Without a rule it returns plausible text with fake token counts.
 * It streams in a few chunks with a small delay and stops on AbortSignal.
 */
export class MockProvider implements ProviderClient {
  readonly id: string
  private rules: Rule[] = []
  readonly calls: { meta: RequestMeta | undefined; model: string; at: number }[] = []

  constructor(
    id = 'mock',
    private readonly opts: MockOptions = {}
  ) {
    this.id = id
  }

  /** Registers a responder for requests whose meta matches `role` and/or `task`. Returns an undo function. */
  on(match: { role?: string; task?: string }, responder: MockResponder | MockReply): () => void {
    const rule: Rule = { ...match, responder: typeof responder === 'function' ? responder : () => responder }
    this.rules.push(rule)
    return () => {
      this.rules = this.rules.filter((r) => r !== rule)
    }
  }

  /** Registers a responder for every request. */
  onAny(responder: MockResponder | MockReply): () => void {
    return this.on({}, responder)
  }

  reset(): void {
    this.rules = []
    this.calls.length = 0
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    this.calls.push({ meta: req.meta, model: req.model, at: Date.now() })
    if (req.signal?.aborted) throw abortError()
    const rule = [...this.rules].reverse().find((r) => {
      if (r.role !== undefined && r.role !== req.meta?.role) return false
      if (r.task !== undefined && r.task !== req.meta?.task) return false
      return true
    })
    const reply: MockReply = rule
      ? await rule.responder(req)
      : `Mock reply for ${req.meta?.role ?? 'unknown role'} / ${req.meta?.task ?? 'unknown task'} (model ${req.model}).`
    const spec = typeof reply === 'string' ? { text: reply } : reply
    const text = spec.text
    const delay = spec.chunkDelayMs ?? this.opts.chunkDelayMs ?? 5
    const n = Math.max(1, Math.min(spec.chunks ?? this.opts.chunks ?? 4, text.length || 1))
    const size = Math.ceil(text.length / n)
    for (let i = 0; i < text.length; i += size) {
      await sleep(delay, req.signal)
      yield { type: 'delta', text: text.slice(i, i + size) }
    }
    const inputTokens = estimateTokens(req.messages.map((m) => m.content).join('\n'))
    yield {
      type: 'usage',
      usage: {
        inputTokens: spec.usage?.inputTokens ?? inputTokens,
        cachedInputTokens: spec.usage?.cachedInputTokens ?? 0,
        outputTokens: spec.usage?.outputTokens ?? estimateTokens(text)
      }
    }
  }

  async embed(_model: string, inputs: string[]): Promise<number[][]> {
    return inputs.map((s) => hashEmbed(s, this.opts.embeddingDim ?? 64))
  }
}

/** A deterministic fake embedding for tests: hashed bag of words, normalised. Texts that share words are close. */
export function hashEmbed(text: string, dim = 64): number[] {
  const v = new Array<number>(dim).fill(0)
  for (const w of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    let h = 2166136261
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0
    v[h % dim]! += 1
    v[(h >>> 8) % dim]! += 0.5
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}
