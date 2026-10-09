export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Who a request is for. Used by the mock provider to pick a scripted answer, and in logs. */
export interface RequestMeta {
  /** The pipeline agent: glossary, translator, proofreader, qa. */
  role?: string
  task?: string
  /** The project id. */
  project?: string
  unit?: string
}

export interface ChatRequest {
  /** Model id as the provider knows it (without the provider prefix). */
  model: string
  messages: ChatMessage[]
  /** JSON schema for structured output, where the provider supports it. */
  schema?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Extra JSON fields merged into the request body (per-model `extra_body`). */
  extraBody?: Record<string, unknown> | null
  meta?: RequestMeta
}

export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number
  /** The part of the input that came from the provider's prompt cache. */
  cachedInputTokens: number
  outputTokens: number
}

export type ChatEvent = { type: 'delta'; text: string } | { type: 'usage'; usage: Usage }

export interface ProviderClient {
  readonly id: string
  /** Streams the reply. The usage event comes last, when the provider reports it. */
  chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void>
  /** Embeds texts. Only providers with embedding models implement it. */
  embed?(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
}

/** Reads a stream to the end. */
export async function collect(
  stream: AsyncIterable<ChatEvent>,
  onDelta?: (text: string) => void
): Promise<{ text: string; usage: Usage }> {
  let text = ''
  let usage = emptyUsage()
  for await (const ev of stream) {
    if (ev.type === 'delta') {
      text += ev.text
      onDelta?.(ev.text)
    } else usage = ev.usage
  }
  return { text, usage }
}

/** A rough token count: 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Maps an HTTP status to a ProviderError. 408, 425, 429 and 5xx can be retried. */
export function httpError(status: number, bodyText: string, retryAfter?: string | null): ProviderError {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500
  let retryAfterMs: number | undefined
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000
  }
  return new ProviderError(`HTTP ${status}: ${bodyText.slice(0, 300)}`, status, retryable, retryAfterMs)
}
