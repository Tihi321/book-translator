import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelRegistry } from '../src/engine/models/registry'
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

describe('ModelRouter and a config reload during a call', () => {
  /** Answers with its own name once its gate is opened (at once without one). */
  class GateClient implements ProviderClient {
    calls: { model: string; extraBody?: Record<string, unknown> | null }[] = []
    constructor(
      readonly id: string,
      private readonly gate: Promise<void> = Promise.resolve()
    ) {}
    async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
      this.calls.push({ model: req.model, extraBody: req.extraBody })
      await this.gate
      yield { type: 'delta', text: this.id }
      yield { type: 'usage', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }
    }
  }
  const tick = () => new Promise<void>((r) => setImmediate(r))
  const deferred = () => {
    let open!: () => void
    const promise = new Promise<void>((r) => (open = r))
    return { promise, open }
  }

  /** Edits the mock provider in providers.md and loads it again, as the config reload does. */
  async function edit(dir: string, registry: ModelRegistry, change: (text: string) => string): Promise<void> {
    const file = path.join(dir, 'config', 'providers.md')
    const text = await fs.readFile(file, 'utf8')
    const edited = change(text)
    expect(edited).not.toBe(text)
    await fs.writeFile(file, edited)
    await registry.load()
  }
  const concurrency = (n: number) => (t: string) => t.replace(/(\r?\n {2}- id: mock\r?\n {4}kind: mock\r?\n {4}concurrency: )\d+/, `$1${n}`)
  const withoutTranslator = (t: string) => t.replace(/ {6}- id: mock-translator\r?\n {8}family: mock\r?\n/, '')
  const msgs = [{ role: 'user' as const, content: 'x' }]

  async function blockedSetup() {
    const { dir, registry } = await setup()
    await edit(dir, registry, concurrency(1))
    const gate = deferred()
    const first = new GateClient('A', gate.promise)
    registry.providers.get('mock')!.client = first
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    // the first request holds the only slot of the mock provider
    const holder = router.complete(['mock/mock-reviewer'], { messages: msgs })
    await tick()
    expect(first.calls).toHaveLength(1)
    return { dir, registry, router, gate, first, holder }
  }

  it('a request waiting for a slot is sent with the reloaded client once the concurrency went up', async () => {
    const { dir, registry, router, gate, first, holder } = await blockedSetup()
    const waiting = router.complete(['mock/mock-translator'], { messages: msgs })
    await tick()
    expect(first.calls).toHaveLength(1) // still waiting
    await edit(dir, registry, concurrency(2))
    const second = new GateClient('B')
    registry.providers.get('mock')!.client = second
    router.limiter.wakeEvery()
    const r = await waiting
    expect(r.text).toBe('B')
    expect(second.calls).toEqual([{ model: 'mock-translator', extraBody: null }])
    expect(first.calls).toHaveLength(1)
    gate.open()
    expect((await holder).text).toBe('A') // a request already sent finishes on the client it was sent with
    expect(router.limiter.inFlight('mock')).toBe(0)
  })

  it('a model removed during the wait goes to the next model, and says so when it was the only one', async () => {
    const { dir, registry, router, gate, holder } = await blockedSetup()
    const both = router.complete(['mock/mock-translator', 'mock/mock-reviewer'], { messages: msgs })
    const only = router.complete(['mock/mock-translator'], { messages: msgs })
    await tick()
    await edit(dir, registry, (t) => withoutTranslator(concurrency(3)(t)))
    const second = new GateClient('B')
    registry.providers.get('mock')!.client = second
    router.limiter.wakeEvery()
    const r = await both
    expect(r.model.ref).toBe('mock/mock-reviewer')
    expect(r.model).toBe(registry.getModel('mock/mock-reviewer'))
    expect(second.calls.map((c) => c.model)).toEqual(['mock-reviewer'])
    await expect(only).rejects.toThrow('mock/mock-translator: removed or turned off in the config during the call')
    gate.open()
    await holder
    expect(router.limiter.inFlight('mock')).toBe(0)
  })

  it('a provider removed during the wait ends the wait with an error', async () => {
    const { dir, registry, router, gate, holder } = await blockedSetup()
    const waiting = router.complete(['mock/mock-translator'], { messages: msgs })
    await tick()
    await edit(dir, registry, (t) => t.replace(/ {2}- id: mock\r?\n {4}kind: mock\r?\n {4}concurrency: \d+\r?\n {4}models:\r?\n {6}- id: mock-translator\r?\n {8}family: mock\r?\n {6}- id: mock-reviewer\r?\n {8}family: mock-other\r?\n/, ''))
    expect(registry.providers.has('mock')).toBe(false)
    router.limiter.wakeEvery()
    await expect(waiting).rejects.toThrow('provider mock was removed from the config while the request waited')
    gate.open()
    await holder
  })

  it('without a reload the call keeps the objects it resolved and the generation stays', async () => {
    const { registry } = await setup()
    const client = new GateClient('A')
    registry.providers.get('mock')!.client = client
    const router = new ModelRouter(registry, { retries: 0, sleep: noSleep })
    const generation = registry.generation
    const r = await router.complete(['mock/mock-translator'], { messages: msgs })
    expect(r.model).toBe(registry.getModel('mock/mock-translator'))
    expect(registry.generation).toBe(generation)
    await registry.load()
    expect(registry.generation).toBe(generation + 1)
  })
})
