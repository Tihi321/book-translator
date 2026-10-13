import { describe, expect, it } from 'vitest'
import { OpenAiCompatClient } from '../src/engine/models/openaiCompat'
import { collect, ProviderError } from '../src/engine/models/types'

/** A fetch stub that answers with an SSE stream and records the request body. */
function sseFetch(chunks: string[]): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetchImpl, bodies }
}

const STREAM = [
  'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"{}"}}]}\n\n',
  'data: [DONE]\n\n'
]

describe('OpenAiCompatClient response_format', () => {
  const schema = { type: 'object' }
  const messages = [{ role: 'user' as const, content: 'hi' }]

  it('sends the JSON schema as response_format by default', async () => {
    const { fetchImpl, bodies } = sseFetch(STREAM)
    const client = new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl })
    const r = await collect(client.chat({ model: 'm', messages, schema }))
    expect(bodies[0]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema } })
    expect(r.text).toBe('{}')
  })

  it('leaves response_format out with jsonSchema: false, and reasoning_content is not text', async () => {
    const { fetchImpl, bodies } = sseFetch(STREAM)
    const client = new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl, jsonSchema: false })
    const r = await collect(client.chat({ model: 'm', messages, schema }))
    expect(bodies[0]).not.toHaveProperty('response_format')
    expect(r.text).toBe('{}')
  })
})

describe('OpenAiCompatClient listModelInfo', () => {
  const listing = {
    data: [
      { id: 'a/free-model:free', context_length: 131072, top_provider: { max_completion_tokens: 8192 }, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
      { id: 'b/paid', context_length: 32000, pricing: { prompt: '0.0000003', completion: '0.0000025', input_cache_read: '0.00000003' }, architecture: { output_modalities: ['text'] } },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'c/music', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
      { id: 'd/bare' }
    ]
  }
  const client = () => new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl: (async () => new Response(JSON.stringify(listing), { status: 200 })) as typeof fetch })

  it('turns OpenRouter prices per token into USD per 1M tokens', async () => {
    const list = await client().listModelInfo()
    const free = list.find((m) => m.id === 'a/free-model:free')!
    expect(free).toMatchObject({ context: 131072, maxOutput: 8192, price: { in: 0, out: 0 }, textOnly: true })
    const paid = list.find((m) => m.id === 'b/paid')!
    expect(paid.price!.in).toBeCloseTo(0.3, 9)
    expect(paid.price!.out).toBeCloseTo(2.5, 9)
    expect(paid.price!.cachedIn).toBeCloseTo(0.03, 9)
  })

  it('treats a negative price as no price, and a missing price as none', async () => {
    const list = await client().listModelInfo()
    expect(list.find((m) => m.id === 'openrouter/auto')!.price).toBeUndefined()
    expect(list.find((m) => m.id === 'd/bare')!.price).toBeUndefined()
  })

  it('marks models that answer with something besides text', async () => {
    const list = await client().listModelInfo()
    expect(list.find((m) => m.id === 'c/music')!.textOnly).toBe(false)
    expect(list.find((m) => m.id === 'd/bare')!.textOnly).toBe(true)
  })

  it('listModels returns the ids', async () => {
    expect(await client().listModels()).toEqual(['a/free-model:free', 'b/paid', 'openrouter/auto', 'c/music', 'd/bare'])
  })
})

describe('OpenAiCompatClient network errors', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }]
  const failWith = (code?: string) => (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: code ? { code } : undefined })
  }) as unknown as typeof fetch

  it('flags a refused connection as unreachable (and still retryable)', async () => {
    const client = new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl: failWith('ECONNREFUSED') })
    const err = await collect(client.chat({ model: 'm', messages })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ unreachable: true, retryable: true })
  })

  it('does not flag other network errors as unreachable', async () => {
    const client = new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl: failWith('ECONNRESET') })
    const err = await collect(client.chat({ model: 'm', messages })).catch((e: unknown) => e)
    expect(err).toMatchObject({ unreachable: false, retryable: true })
  })
})

describe('OpenAiCompatClient LM Studio loading', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }]
  const loadConfig = () => ({ parallel: 3, context: 32768, ttlMinutes: 10 })

  /** An LM Studio stub: `models` is the state of /api/v1/models, a load makes the model loaded. */
  function lmStudio(models: { key: string; loaded: boolean }[]) {
    const state = models.map((m) => ({ ...m }))
    const log: { url: string; body?: Record<string, unknown> }[] = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      log.push({ url: u, body })
      if (u.endsWith('/api/v1/models/load')) {
        await new Promise((r) => setTimeout(r, 20))
        const m = state.find((x) => x.key === body?.model)
        if (m) m.loaded = true
        return new Response('{}', { status: 200 })
      }
      if (u.endsWith('/api/v1/models')) {
        return new Response(JSON.stringify({ models: state.map((m) => ({ key: m.key, type: 'llm', loaded_instances: m.loaded ? [{ id: m.key }] : [] })) }), { status: 200 })
      }
      return new Response(STREAM.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const loads = () => log.filter((l) => l.url.endsWith('/models/load'))
    return { fetchImpl, log, loads }
  }

  it('loads a model that is not loaded, once for parallel requests, with the configured settings', async () => {
    const lm = lmStudio([{ key: 'big', loaded: false }])
    const client = new OpenAiCompatClient({ id: 'lm', baseUrl: 'http://lm:1234/v1', fetchImpl: lm.fetchImpl, loadConfig, lmsPath: undefined })
    const results = await Promise.all([1, 2, 3].map(() => collect(client.chat({ model: 'big', messages }))))
    expect(results.every((r) => r.text === '{}')).toBe(true)
    expect(lm.loads()).toHaveLength(1)
    expect(lm.loads()[0]!.body).toEqual({ model: 'big', context_length: 32768, parallel: 3 })
    // the loaded model is not loaded again
    await collect(client.chat({ model: 'big', messages }))
    expect(lm.loads()).toHaveLength(1)
  })

  it('uses a model that is already loaded as it is', async () => {
    const lm = lmStudio([{ key: 'big', loaded: true }])
    const client = new OpenAiCompatClient({ id: 'lm', baseUrl: 'http://lm:1234/v1', fetchImpl: lm.fetchImpl, loadConfig, lmsPath: undefined })
    await collect(client.chat({ model: 'big', messages }))
    expect(lm.loads()).toHaveLength(0)
  })

  it('fails at once, without a retry, for a model LM Studio does not have', async () => {
    const lm = lmStudio([{ key: 'big', loaded: true }])
    const client = new OpenAiCompatClient({ id: 'lm', baseUrl: 'http://lm:1234/v1', fetchImpl: lm.fetchImpl, loadConfig, lmsPath: undefined })
    const err = await collect(client.chat({ model: 'nope', messages })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ retryable: false })
    expect((err as Error).message).toMatch(/no model "nope"/)
    expect(lm.log.some((l) => l.url.endsWith('/chat/completions'))).toBe(false)
  })

  it('sends the request as it is when the server has no LM Studio API', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (String(url).endsWith('/api/v1/models')) return new Response('not found', { status: 404 })
      return new Response(STREAM.join(''), { status: 200 })
    }) as typeof fetch
    const client = new OpenAiCompatClient({ id: 'lm', baseUrl: 'http://x/v1', fetchImpl, loadConfig, lmsPath: undefined })
    expect((await collect(client.chat({ model: 'any', messages }))).text).toBe('{}')
    expect(calls.some((c) => c.endsWith('/models/load'))).toBe(false)
  })
})
