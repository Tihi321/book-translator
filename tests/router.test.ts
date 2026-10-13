import { afterEach, describe, expect, it } from 'vitest'
import { ModelRouter } from '../src/engine/models/router'
import { ProviderError } from '../src/engine/models/types'
import type { ChatEvent, ChatRequest, ProviderClient } from '../src/engine/models/types'
import { seededRegistry } from './helpers'

class FlakyClient implements ProviderClient {
  calls = 0
  constructor(
    readonly id: string,
    private readonly failures: number,
    private readonly error: () => Error
  ) {}
  async *chat(_req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    this.calls++
    if (this.calls <= this.failures) throw this.error()
    yield { type: 'delta', text: 'ok' }
    yield { type: 'usage', usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 } }
  }
}

const noSleep = () => Promise.resolve()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup() {
  const s = await seededRegistry()
  cleanups.push(s.cleanup)
  return s
}

describe('ModelRouter', () => {
  it('streams from the mock provider and reports usage and cost', async () => {
    const { registry } = await setup()
    registry.mock.onAny('hello')
    const router = new ModelRouter(registry, { sleep: noSleep })
    const r = await router.complete(['mock/mock-translator'], { messages: [{ role: 'user', content: 'hi' }], meta: { role: 'translator' } })
    expect(r.text).toBe('hello')
    expect(r.model.ref).toBe('mock/mock-translator')
    expect(r.costUsd).toBe(0)
    expect(r.usage.outputTokens).toBeGreaterThan(0)
  })

  it('retries a retryable error on the same model', async () => {
    const { registry } = await setup()
    const client = new FlakyClient('deepseek', 2, () => new ProviderError('busy', 429, true))
    registry.providers.get('deepseek')!.client = client
    const router = new ModelRouter(registry, { retries: 2, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-flash'], { messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('ok')
    expect(client.calls).toBe(3)
    expect(r.attempts).toBe(3)
    // 1M in at $0.30 + 1M out at $1.20
    expect(r.costUsd).toBeCloseTo(1.5, 6)
  })

  it('falls back to the next model when retries run out', async () => {
    const { registry } = await setup()
    const bad = new FlakyClient('deepseek', 99, () => new ProviderError('down', 503, true))
    registry.providers.get('deepseek')!.client = bad
    registry.mock.onAny('from mock')
    const router = new ModelRouter(registry, { retries: 1, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-flash', 'mock/mock-translator'], { messages: [{ role: 'user', content: 'x' }] })
    expect(r.model.ref).toBe('mock/mock-translator')
    expect(r.text).toBe('from mock')
    expect(bad.calls).toBe(2)
  })

  it('does not retry a non-retryable error but still falls back', async () => {
    const { registry } = await setup()
    const bad = new FlakyClient('deepseek', 99, () => new ProviderError('bad request', 400, false))
    registry.providers.get('deepseek')!.client = bad
    const router = new ModelRouter(registry, { retries: 3, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-flash', 'mock/mock-reviewer'], { messages: [{ role: 'user', content: 'x' }] })
    expect(bad.calls).toBe(1)
    expect(r.model.ref).toBe('mock/mock-reviewer')
  })

  it('throws the last error when every model fails, and when no model is available', async () => {
    const { registry } = await setup()
    registry.providers.get('deepseek')!.client = new FlakyClient('deepseek', 99, () => new ProviderError('down', 500, true))
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    await expect(router.complete(['deepseek/deepseek-flash'], { messages: [] })).rejects.toThrow('down')
    await expect(router.complete(['nope/none'], { messages: [] })).rejects.toThrow('no available model')
  })

  it('stops on abort', async () => {
    const { registry } = await setup()
    const ac = new AbortController()
    ac.abort()
    const router = new ModelRouter(registry, { sleep: noSleep })
    await expect(router.complete(['mock/mock-translator'], { messages: [], signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('ModelRouter provider limits and down servers', () => {
  const dailyLimit = () => new ProviderError('HTTP 429: {"error":{"message":"Rate limit exceeded: free-models-per-day"}}', 429, true)
  const unreachable = () => new ProviderError('network error: fetch failed (ECONNREFUSED)', undefined, true, undefined, true)

  it('goes to the next model on a daily-limit 429 without retries, and skips the provider afterwards', async () => {
    const { registry } = await setup()
    const or = new FlakyClient('openrouter', 99, dailyLimit)
    registry.providers.get('openrouter')!.client = or
    registry.mock.onAny('from mock')
    const router = new ModelRouter(registry, { retries: 2, sleep: noSleep })
    const full: string[] = []
    router.onProviderDayFull = (p) => full.push(p.id)
    const refs = ['openrouter/google/gemini-2.5-flash', 'mock/mock-translator']
    const r = await router.complete(refs, { messages: [{ role: 'user', content: 'x' }] })
    expect(r.model.ref).toBe('mock/mock-translator')
    expect(or.calls).toBe(1)
    expect(full).toEqual(['openrouter'])
    expect(router.limiter.dayFull(registry.providers.get('openrouter')!)).toBe(true)
    // afterwards the provider is left out while another model is left
    expect(router.resolve(refs).map((m) => m.ref)).toEqual(['mock/mock-translator'])
    await router.complete(refs, { messages: [{ role: 'user', content: 'x' }] })
    expect(or.calls).toBe(1)
    expect(full).toHaveLength(1)
  })

  it('keeps a day-full provider when nothing else is left', async () => {
    const { registry } = await setup()
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    router.limiter.markDayFull(registry.providers.get('openrouter')!)
    expect(router.resolve(['openrouter/google/gemini-2.5-flash']).map((m) => m.ref)).toEqual(['openrouter/google/gemini-2.5-flash'])
  })

  it('skips a provider that reached its rpd', async () => {
    const { registry } = await setup()
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    const or = registry.providers.get('openrouter')!
    or.rpd = 1
    router.limiter.noteRequest(or)
    expect(router.resolve(['openrouter/google/gemini-2.5-flash', 'mock/mock-translator']).map((m) => m.ref)).toEqual(['mock/mock-translator'])
  })

  it('a per-minute 429 is still retried, not taken for a daily limit', async () => {
    const { registry } = await setup()
    const client = new FlakyClient('deepseek', 1, () => new ProviderError('HTTP 429: rate limit exceeded, retry shortly', 429, true))
    registry.providers.get('deepseek')!.client = client
    const router = new ModelRouter(registry, { retries: 2, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-flash'], { messages: [] })
    expect(r.attempts).toBe(2)
    expect(router.limiter.dayFull(registry.providers.get('deepseek')!)).toBe(false)
  })

  it('marks an unreachable auto server down at once and moves on without retries', async () => {
    const { registry } = await setup()
    const strata = new FlakyClient('strata', 99, unreachable)
    registry.providers.get('strata')!.client = strata
    registry.mock.onAny('from mock')
    const router = new ModelRouter(registry, { retries: 2, sleep: noSleep })
    const down: string[] = []
    router.onProviderDown = (p) => down.push(p.id)
    const refs = ['strata/qwen3.8-flash-next', 'mock/mock-translator']
    const r = await router.complete(refs, { messages: [{ role: 'user', content: 'x' }] })
    expect(r.model.ref).toBe('mock/mock-translator')
    expect(strata.calls).toBe(1)
    expect(down).toEqual(['strata'])
    expect(registry.providers.get('strata')!.down).toBe(true)
    // skipped from now on
    expect(router.resolve(refs).map((m) => m.ref)).toEqual(['mock/mock-translator'])
    await router.complete(refs, { messages: [{ role: 'user', content: 'x' }] })
    expect(strata.calls).toBe(1)
    expect(down).toHaveLength(1)
  })

  it('keeps a down server when nothing else is left', async () => {
    const { registry } = await setup()
    registry.markDown(registry.providers.get('strata')!)
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    expect(router.resolve(['strata/qwen3.8-flash-next']).map((m) => m.ref)).toEqual(['strata/qwen3.8-flash-next'])
  })

  it('still retries an unreachable error on a server that is not auto', async () => {
    const { registry } = await setup()
    const client = new FlakyClient('deepseek', 99, unreachable)
    registry.providers.get('deepseek')!.client = client
    const router = new ModelRouter(registry, { retries: 2, sleep: noSleep })
    await expect(router.complete(['deepseek/deepseek-flash'], { messages: [] })).rejects.toThrow('ECONNREFUSED')
    expect(client.calls).toBe(3)
    expect(registry.providers.get('deepseek')!.down).toBe(false)
  })

  it('skips a model whose provider went down while the call was running its list', async () => {
    const { registry } = await setup()
    registry.providers.get('deepseek')!.client = new FlakyClient('deepseek', 99, () => new ProviderError('bad', 400))
    const strata = new FlakyClient('strata', 0, () => new Error('never'))
    registry.providers.get('strata')!.client = strata
    registry.mock.onAny('from mock')
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    // strata is second: it goes down while the first model fails
    router.limiter.markDayFull(registry.providers.get('openrouter')!)
    const events = []
    for await (const ev of router.chat(['deepseek/deepseek-flash', 'strata/qwen3.8-flash-next', 'mock/mock-translator'], { messages: [] })) {
      events.push(ev)
      if (ev.type === 'attempt') registry.markDown(registry.providers.get('strata')!)
    }
    expect(strata.calls).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'done', model: { ref: 'mock/mock-translator' } })
  })

  it('does not retry a context-size error and goes to the next model', async () => {
    const { registry } = await setup()
    const small = new FlakyClient('deepseek', 99, () => new ProviderError('HTTP 400: request exceeds the available context size (n_ctx 4096)', 500, true))
    registry.providers.get('deepseek')!.client = small
    registry.mock.onAny('from mock')
    const router = new ModelRouter(registry, { retries: 3, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-flash', 'mock/mock-translator'], { messages: [] })
    expect(small.calls).toBe(1)
    expect(r.model.ref).toBe('mock/mock-translator')
  })

  it('says why each model failed when every one fails', async () => {
    const { registry } = await setup()
    registry.providers.get('deepseek')!.client = new FlakyClient('deepseek', 99, () => new ProviderError('HTTP 503: overloaded', 503, true))
    registry.providers.get('openai')!.client = new FlakyClient('openai', 99, () => new ProviderError('HTTP 401: bad key', 401, false))
    const router = new ModelRouter(registry, { retries: 1, sleep: noSleep })
    const err = await router.complete(['deepseek/deepseek-flash', 'openai/gpt-5'], { messages: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as Error).message).toBe('all models failed. deepseek/deepseek-flash: HTTP 503: overloaded | openai/gpt-5: HTTP 401: bad key')
  })

  it('throws the plain error when a single model fails', async () => {
    const { registry } = await setup()
    registry.providers.get('deepseek')!.client = new FlakyClient('deepseek', 99, () => new ProviderError('HTTP 503: overloaded', 503, true))
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    await expect(router.complete(['deepseek/deepseek-flash'], { messages: [] })).rejects.toThrow('HTTP 503: overloaded')
  })
})

describe('ModelRouter aliases and group order', () => {
  const lmLoad = { parallel: 4, context: 131072, ttlMinutes: 60 }

  it('resolves aliases to the default models', async () => {
    const { registry } = await setup()
    registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, lmLoad })
    const router = new ModelRouter(registry)
    expect(router.resolve(['strata', 'paid', 'lmstudio', 'deepseek/deepseek-flash']).map((m) => m.ref)).toEqual(['strata/qwen3.8-flash-next', 'deepseek/deepseek-flash'])
  })

  it('sorts the list by the group order and keeps the order inside a group', async () => {
    const { registry } = await setup()
    registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, order: ['strata', 'paid'], lmLoad })
    const router = new ModelRouter(registry)
    const refs = ['paid', 'deepseek/deepseek-v4-pro', 'strata/qwen3.8-flash-next-low', 'strata']
    expect(router.resolve(refs).map((m) => m.ref)).toEqual(['strata/qwen3.8-flash-next-low', 'strata/qwen3.8-flash-next', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'])
    registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, order: [], lmLoad })
    expect(router.resolve(refs).map((m) => m.ref)).toEqual(['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'strata/qwen3.8-flash-next-low', 'strata/qwen3.8-flash-next'])
  })

  it('calls the model an alias stands for', async () => {
    const { registry } = await setup()
    registry.setDefaults({ aliases: { paid: 'mock/mock-translator' }, lmLoad })
    registry.mock.onAny('via alias')
    const router = new ModelRouter(registry, { sleep: noSleep })
    const r = await router.complete(['paid'], { messages: [{ role: 'user', content: 'x' }] })
    expect(r.model.ref).toBe('mock/mock-translator')
    expect(r.text).toBe('via alias')
  })
})
