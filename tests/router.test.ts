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
    const r = await router.complete(['deepseek/deepseek-v4-flash'], { messages: [{ role: 'user', content: 'x' }] })
    expect(r.text).toBe('ok')
    expect(client.calls).toBe(3)
    expect(r.attempts).toBe(3)
    // 1M in at $0.14 + 1M out at $0.28
    expect(r.costUsd).toBeCloseTo(0.42, 6)
  })

  it('falls back to the next model when retries run out', async () => {
    const { registry } = await setup()
    const bad = new FlakyClient('deepseek', 99, () => new ProviderError('down', 503, true))
    registry.providers.get('deepseek')!.client = bad
    registry.mock.onAny('from mock')
    const router = new ModelRouter(registry, { retries: 1, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-v4-flash', 'mock/mock-translator'], { messages: [{ role: 'user', content: 'x' }] })
    expect(r.model.ref).toBe('mock/mock-translator')
    expect(r.text).toBe('from mock')
    expect(bad.calls).toBe(2)
  })

  it('does not retry a non-retryable error but still falls back', async () => {
    const { registry } = await setup()
    const bad = new FlakyClient('deepseek', 99, () => new ProviderError('bad request', 400, false))
    registry.providers.get('deepseek')!.client = bad
    const router = new ModelRouter(registry, { retries: 3, sleep: noSleep })
    const r = await router.complete(['deepseek/deepseek-v4-flash', 'mock/mock-reviewer'], { messages: [{ role: 'user', content: 'x' }] })
    expect(bad.calls).toBe(1)
    expect(r.model.ref).toBe('mock/mock-reviewer')
  })

  it('throws the last error when every model fails, and when no model is available', async () => {
    const { registry } = await setup()
    registry.providers.get('deepseek')!.client = new FlakyClient('deepseek', 99, () => new ProviderError('down', 500, true))
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    await expect(router.complete(['deepseek/deepseek-v4-flash'], { messages: [] })).rejects.toThrow('down')
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
