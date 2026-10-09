import { parseSse } from './sse'
import { httpError, ProviderError } from './types'
import type { ChatEvent, ChatRequest, ProviderClient } from './types'

export interface AnthropicOptions {
  id: string
  baseUrl?: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Native Anthropic Messages API, streaming. */
export class AnthropicClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch

  constructor(private readonly opts: AnthropicOptions) {
    this.id = opts.id
    this.base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const messages = req.messages.filter((m) => m.role !== 'system')
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      messages,
      ...(system ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.extraBody ?? {})
    }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15 * 60_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.f(`${this.base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    if (!res.body) throw new ProviderError('empty response body', res.status, true)

    let inputTokens = 0
    let cached = 0
    let outputTokens = 0
    try {
      for await (const msg of parseSse(res.body)) {
        let json: AnthropicEvent
        try {
          json = JSON.parse(msg.data) as AnthropicEvent
        } catch {
          continue
        }
        if (json.type === 'message_start' && json.message?.usage) {
          const u = json.message.usage
          cached = u.cache_read_input_tokens ?? 0
          // Anthropic reports uncached, cache-write and cache-read input separately.
          inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached
          outputTokens = u.output_tokens ?? 0
        } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
          yield { type: 'delta', text: json.delta.text }
        } else if (json.type === 'message_delta' && json.usage?.output_tokens !== undefined) {
          outputTokens = json.usage.output_tokens
        } else if (json.type === 'error') {
          throw new ProviderError(`provider error: ${JSON.stringify(json.error).slice(0, 300)}`, undefined, true)
        }
      }
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    yield { type: 'usage', usage: { inputTokens, cachedInputTokens: cached, outputTokens } }
  }
}

interface AnthropicEvent {
  type: string
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  delta?: { type?: string; text?: string }
  usage?: { output_tokens?: number }
  error?: unknown
}

export function asProviderError(err: unknown, caller?: AbortSignal): unknown {
  if (caller?.aborted || err instanceof ProviderError) return err
  const e = err as Error
  if (e?.name === 'TimeoutError') return new ProviderError('request timed out', undefined, true)
  if (e?.name === 'AbortError') return err
  return new ProviderError(`network error: ${e?.message ?? String(err)}`, undefined, true)
}
