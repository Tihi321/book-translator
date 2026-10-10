import { parseSse } from './sse'
import { httpError, ProviderError } from './types'
import type { ChatEvent, ChatRequest, ProviderClient, Usage } from './types'

export interface OpenAiCompatOptions {
  id: string
  baseUrl: string
  apiKey?: string
  /** Total time allowed for one request. Default 15 minutes. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Send `schema` as `response_format`. Default true. False for servers that fail a bad answer instead of constraining it. */
  jsonSchema?: boolean
  /** Prefixes added to embedding inputs (nomic wants these). */
  embedPrefixes?: { document: string; query: string }
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) h.authorization = `Bearer ${apiKey}`
  return h
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

/** Converts network failures and timeouts to retryable ProviderErrors. Aborts by the caller pass through. */
function wrapFetchError(err: unknown, caller?: AbortSignal): never {
  if (caller?.aborted) throw err
  if (err instanceof ProviderError) throw err
  const e = err as Error
  if (e?.name === 'TimeoutError') throw new ProviderError('request timed out', undefined, true)
  if (e?.name === 'AbortError') throw err
  throw new ProviderError(`network error: ${e?.message ?? String(err)}`, undefined, true)
}

export class OpenAiCompatClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.id = opts.id
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.extraBody ?? {})
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.schema && this.opts.jsonSchema !== false) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: req.schema } }
    }
    const signal = withTimeout(req.signal, this.opts.timeoutMs ?? 15 * 60_000)
    let res: Response
    try {
      res = await this.f(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: headers(this.opts.apiKey),
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      wrapFetchError(err, req.signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    if (!res.body) throw new ProviderError('empty response body', res.status, true)

    let usage: Usage | undefined
    let finish: string | null = null
    let emitted = false
    try {
      for await (const msg of parseSse(res.body)) {
        if (msg.data.trim() === '[DONE]') break
        let json: OpenAiChunk
        try {
          json = JSON.parse(msg.data) as OpenAiChunk
        } catch {
          continue
        }
        if (json.error) throw new ProviderError(`provider error: ${JSON.stringify(json.error).slice(0, 300)}`, undefined, true)
        const text = json.choices?.[0]?.delta?.content
        if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason
        if (text) {
          emitted = true
          yield { type: 'delta', text }
        }
        if (json.usage) usage = toUsage(json.usage)
      }
    } catch (err) {
      wrapFetchError(err, req.signal)
    }
    if (!emitted && finish === 'length') {
      throw new ProviderError(
        `the model stopped at its token limit without an answer (${usage?.inputTokens ?? '?'} tokens in, ${usage?.outputTokens ?? '?'} out): a thinking model used up the answer budget, or the loaded model's context window is too small for this request`
      )
    }
    if (usage) yield { type: 'usage', usage }
  }

  async embed(model: string, inputs: string[], signal?: AbortSignal): Promise<number[][]> {
    let res: Response
    try {
      res = await this.f(`${this.base}/embeddings`, {
        method: 'POST',
        headers: headers(this.opts.apiKey),
        body: JSON.stringify({ model, input: inputs }),
        signal: withTimeout(signal, this.opts.timeoutMs ?? 15 * 60_000)
      })
    } catch (err) {
      wrapFetchError(err, signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] }
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
  }

  /** Embeds with the document/query prefixes some models need. */
  embedWithPrefix(model: string, inputs: string[], kind: 'document' | 'query', signal?: AbortSignal): Promise<number[][]> {
    const p = this.opts.embedPrefixes
    const prefix = p ? p[kind] : ''
    return this.embed(model, inputs.map((s) => prefix + s), signal)
  }

  /** LM Studio only: the context window each model is loaded with (`GET /api/v0/models`). Empty for other servers. */
  async contextLengths(signal?: AbortSignal): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    try {
      const origin = new URL(this.base).origin
      const res = await this.f(`${origin}/api/v0/models`, { headers: headers(this.opts.apiKey), signal: withTimeout(signal, 3000) })
      if (!res.ok) return out
      const json = (await res.json()) as { data?: { id: string; loaded_context_length?: number }[] }
      for (const m of json.data ?? []) if (m.loaded_context_length) out.set(m.id, m.loaded_context_length)
    } catch {
      /* not LM Studio */
    }
    return out
  }

  /** Lists the model ids the server offers (`GET /models`). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.f(`${this.base}/models`, { headers: headers(this.opts.apiKey), signal: withTimeout(signal, 5000) })
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''))
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).map((m) => m.id)
  }
}

interface OpenAiChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
  } | null
  error?: unknown
}

function toUsage(u: NonNullable<OpenAiChunk['usage']>): Usage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0
  }
}
