import { asProviderError } from './anthropic'
import { parseSse } from './sse'
import { httpError, ProviderError } from './types'
import type { ChatEvent, ChatRequest, ProviderClient } from './types'

export interface GeminiOptions {
  id: string
  baseUrl?: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Native Gemini API (`streamGenerateContent`), streaming. */
export class GeminiClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch

  constructor(private readonly opts: GeminiOptions) {
    this.id = opts.id
    this.base = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const contents = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
    const generationConfig: Record<string, unknown> = {
      ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.schema ? { responseMimeType: 'application/json' } : {})
    }
    const body = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig,
      ...(req.extraBody ?? {})
    }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15 * 60_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.f(`${this.base}/v1beta/models/${req.model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    if (!res.body) throw new ProviderError('empty response body', res.status, true)

    let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    try {
      for await (const msg of parseSse(res.body)) {
        let json: GeminiChunk
        try {
          json = JSON.parse(msg.data) as GeminiChunk
        } catch {
          continue
        }
        for (const part of json.candidates?.[0]?.content?.parts ?? []) {
          if (part.text && !part.thought) yield { type: 'delta', text: part.text }
        }
        const u = json.usageMetadata
        if (u) {
          usage = {
            inputTokens: u.promptTokenCount ?? 0,
            cachedInputTokens: u.cachedContentTokenCount ?? 0,
            // Thinking tokens are billed as output.
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
          }
        }
      }
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    yield { type: 'usage', usage }
  }
}

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
}
