import { execFile } from 'node:child_process'
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
  /** LM Studio: before a chat request, load the model if it isn't loaded yet, with these settings. */
  loadConfig?: (model: string) => { parallel: number; context: number; ttlMinutes: number }
  /** LM Studio's `lms` command line. It loads with an idle time (`--ttl`), which the REST load can't; without it the REST API is used. */
  lmsPath?: string
}

const LOAD_TIMEOUT_MS = 10 * 60_000

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) h.authorization = `Bearer ${apiKey}`
  return h
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

/** Connection errors that mean nothing listens there (the server is not started), not a hiccup of a running one. */
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EADDRNOTAVAIL'])

/** Converts network failures and timeouts to retryable ProviderErrors. Aborts by the caller pass through. */
function wrapFetchError(err: unknown, caller?: AbortSignal): never {
  if (caller?.aborted) throw err
  if (err instanceof ProviderError) throw err
  const e = err as Error & { cause?: { code?: string } }
  if (e?.name === 'TimeoutError') throw new ProviderError('request timed out', undefined, true)
  if (e?.name === 'AbortError') throw err
  const code = e?.cause?.code
  throw new ProviderError(`network error: ${e?.message ?? String(err)}${code ? ` (${code})` : ''}`, undefined, true, undefined, !!code && UNREACHABLE.has(code))
}

export class OpenAiCompatClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch
  /** Loads in progress, so parallel requests for one model load it once. */
  private loading = new Map<string, Promise<void>>()

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.id = opts.id
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    if (this.opts.loadConfig) await this.ensureLoaded(req.model, req.signal)
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

  /** LM Studio: loads `model` with `loadConfig` unless it is loaded already. A model LM Studio doesn't have fails at once (not retryable). */
  private async ensureLoaded(model: string, signal?: AbortSignal): Promise<void> {
    let p = this.loading.get(model)
    if (!p) {
      p = this.loadIfNeeded(model, this.opts.loadConfig!(model)).finally(() => this.loading.delete(model))
      this.loading.set(model, p)
    }
    try {
      await p
    } catch (err) {
      wrapFetchError(err, signal)
    }
  }

  private async loadIfNeeded(model: string, cfg: { parallel: number; context: number; ttlMinutes: number }): Promise<void> {
    const root = this.base.replace(/\/v1$/, '')
    const res = await this.f(`${root}/api/v1/models`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return // not LM Studio's API: send the request as it is
    const json = (await res.json()) as { models?: { key: string; type?: string; loaded_instances?: { id: string }[] }[] }
    const m = json.models?.find((x) => x.key === model || x.loaded_instances?.some((i) => i.id === model))
    if (!m) throw new ProviderError(`LM Studio has no model "${model}": download it first (lms get ${model})`)
    if (m.loaded_instances?.length) return
    if (this.opts.lmsPath) {
      const args = ['load', model, '-c', String(cfg.context), '--parallel', String(cfg.parallel), '--ttl', String(cfg.ttlMinutes * 60), '-y']
      await new Promise<void>((resolve, reject) =>
        execFile(this.opts.lmsPath!, args, { timeout: LOAD_TIMEOUT_MS, windowsHide: true }, (err, _out, stderr) =>
          err ? reject(new ProviderError(`LM Studio could not load ${model}: ${(String(stderr).trim() || err.message).slice(0, 300)}`)) : resolve()
        )
      )
      return
    }
    const load = await this.f(`${root}/api/v1/models/load`, {
      method: 'POST',
      headers: headers(this.opts.apiKey),
      body: JSON.stringify({ model, context_length: cfg.context, parallel: cfg.parallel }),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS)
    })
    if (!load.ok) throw new ProviderError(`LM Studio could not load ${model}: HTTP ${load.status} ${(await load.text().catch(() => '')).slice(0, 300)}`, load.status)
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
    return (await this.listModelInfo(signal)).map((m) => m.id)
  }

  /** The models the server offers, with the context, output limit and prices when it lists them (OpenRouter does, LM Studio doesn't). */
  async listModelInfo(signal?: AbortSignal): Promise<ListedModel[]> {
    const res = await this.f(`${this.base}/models`, { headers: headers(this.opts.apiKey), signal: withTimeout(signal, 15000) })
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''))
    const json = (await res.json()) as { data?: OpenAiModelEntry[] }
    return (json.data ?? []).filter((m) => typeof m?.id === 'string').map(listedModel)
  }
}

/** One model of a `GET /models` answer. Only `id` is standard; OpenRouter adds the rest. */
interface OpenAiModelEntry {
  id: string
  context_length?: number
  top_provider?: { max_completion_tokens?: number | null } | null
  /** USD per token, as strings. */
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string } | null
  architecture?: { output_modalities?: string[] } | null
}

export interface ListedModel {
  id: string
  context?: number
  maxOutput?: number
  /** USD per 1M tokens, when the server lists prices. */
  price?: { in: number; out: number; cachedIn?: number }
  /** False when the server says the model answers with something besides text (music, images). */
  textOnly: boolean
}

export function listedModel(m: OpenAiModelEntry): ListedModel {
  const perM = (v: string | undefined) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v) * 1_000_000)
  const pIn = perM(m.pricing?.prompt)
  const pOut = perM(m.pricing?.completion)
  const out = m.architecture?.output_modalities
  return {
    id: m.id,
    context: typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : undefined,
    maxOutput: m.top_provider?.max_completion_tokens || undefined,
    // a negative price is OpenRouter's "varies" (its auto router): not a price the budget can use
    price: pIn !== undefined && pOut !== undefined && pIn >= 0 && pOut >= 0 ? { in: pIn, out: pOut, cachedIn: perM(m.pricing?.input_cache_read) } : undefined,
    textOnly: !out || (out.length === 1 && out[0] === 'text')
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
