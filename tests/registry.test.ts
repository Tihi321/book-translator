import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeCost, modelDefaultsOf, ModelRegistry } from '../src/engine/models/registry'
import { defaultsSchema } from '../src/shared/schemas'
import { initDataFolder } from '../src/engine/store/dataFolder'
import { SEED_DIR, seededRegistry, tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe('ModelRegistry with the seed providers.md', () => {
  it('loads the providers and models', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const ids = [...s.registry.providers.keys()]
    expect(ids).toEqual(expect.arrayContaining(['deepseek', 'openai', 'openrouter', 'anthropic', 'gemini', 'lmstudio', 'strata', 'ollama', 'custom', 'mock']))
    expect(s.registry.getModel('mock/mock-translator')).toBeDefined()
    expect(s.registry.getModel('mock/mock-reviewer')).toBeDefined()
    expect(s.registry.providers.get('ollama')!.available).toBe(false)
    expect(s.registry.providers.get('custom')!.available).toBe(false)
    expect(s.registry.providers.get('mock')!.available).toBe(true)
    expect(s.registry.providers.get('client')).toMatchObject({ available: true, local: true })
    expect(s.registry.providers.get('strata')).toMatchObject({ available: true, local: true, jsonSchema: false })
    expect(s.registry.contextLength('strata/qwen3.8-flash-next')).toBe(131072)
    expect(s.registry.getModel('strata/qwen3.8-flash-next')?.extraBody).toEqual({ reasoning_effort: 'none' })
    expect(s.registry.getModel('strata/qwen3.8-flash-next-low')?.extraBody).toEqual({ reasoning_effort: 'low' })
  })

  it('marks API providers unavailable without a key', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    const registry = new ModelRegistry(dir, { keys: () => undefined })
    await registry.load()
    expect(registry.providers.get('openai')!.available).toBe(false)
    expect(registry.providers.get('openai')!.unavailableReason).toMatch(/OPENAI_API_KEY/)
    expect(registry.providers.get('lmstudio')!.available).toBe(true)
  })

  it('computes cost per 1M tokens, cached input at its own price', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const m = s.registry.getModel('deepseek/deepseek-flash')!
    expect(computeCost(m, { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(1.5, 6)
  })

  it('reports the effective context: loaded, then providers.md, then 8192', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const r = s.registry
    expect(r.contextLength('deepseek/deepseek-flash')).toBe(1_000_000)
    expect(r.contextLength('client/claude-code')).toBe(200000)
    expect(r.contextLength('mock/mock-translator')).toBe(8192)
    expect(r.contextLength('unknown/model')).toBe(8192)
    r.getModel('deepseek/deepseek-flash')!.loadedContext = 32768
    expect(r.contextLength('deepseek/deepseek-flash')).toBe(32768)
  })

  it('a model takes its context from the model, then the provider, then 200000 for a client', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    const text = `---
kind: providers
providers:
  - id: client
    kind: client
    models:
      - id: m
        context: 50000
  - id: client2
    kind: client
    context: 120000
    models:
      - id: m
  - id: client3
    kind: client
    models:
      - id: m
  - id: compat
    kind: openai-compat
    local: true
    base_url: http://localhost:1/v1
    context: 64000
    models:
      - id: m
      - id: own
        context: 4096
  - id: mock
    kind: mock
    models:
      - id: mock-translator
---
`
    await fs.writeFile(path.join(dir, 'config', 'providers.md'), text)
    const registry = new ModelRegistry(dir, { keys: () => 'test-key' })
    await registry.load()
    expect(registry.contextLength('client/m')).toBe(50000)
    expect(registry.contextLength('client2/m')).toBe(120000)
    expect(registry.contextLength('client3/m')).toBe(200000)
    expect(registry.contextLength('compat/m')).toBe(64000)
    expect(registry.contextLength('compat/own')).toBe(4096)
    expect(registry.contextLength('mock/mock-translator')).toBe(8192)
  })

  it('discovery of an unreachable server does not throw', async () => {
    const s = await seededRegistry({ fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) })
    cleanups.push(s.cleanup)
    const res = await s.registry.discover()
    expect(res.find((d) => d.provider === 'lmstudio')?.error).toBeTruthy()
  })

  it('discovery adds models and takes the loaded context from LM Studio', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      const body = u.endsWith('/api/v0/models') ? { data: [{ id: 'qwen-test', loaded_context_length: 16384 }] } : { data: [{ id: 'qwen-test' }] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const s = await seededRegistry({ fetchImpl })
    cleanups.push(s.cleanup)
    await s.registry.discover()
    const m = s.registry.getModel('lmstudio/qwen-test')
    expect(m?.discovered).toBe(true)
    expect(s.registry.contextLength('lmstudio/qwen-test')).toBe(16384)
  })
})

/** A fetch stub routed by URL part: the first matching route answers, anything else fails like an unreachable server. */
function routedFetch(routes: [string, unknown | (() => Response)][]): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    for (const [part, answer] of routes) {
      if (u.includes(part)) return typeof answer === 'function' ? (answer as () => Response)() : new Response(JSON.stringify(answer), { status: 200 })
    }
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }) as typeof fetch
}

const OPENROUTER_LIST = {
  data: [
    { id: 'acme/free-chat:free', context_length: 65536, top_provider: { max_completion_tokens: 4096 }, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'acme/paid-chat', context_length: 32000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { output_modalities: ['text'] } },
    { id: 'acme/content-safety:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'acme/music:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
    { id: 'acme/unpriced' }
  ]
}

describe('discovery of OpenRouter models (discover: free)', () => {
  it('adds only free text models, with context, output limit and price 0, and skips discover_skip words', async () => {
    const s = await seededRegistry({ fetchImpl: routedFetch([['openrouter.ai', OPENROUTER_LIST]]) })
    cleanups.push(s.cleanup)
    const res = await s.registry.discover()
    expect(res.find((d) => d.provider === 'openrouter')).toEqual({ provider: 'openrouter', found: 1 })
    const m = s.registry.getModel('openrouter/acme/free-chat:free')!
    expect(m).toMatchObject({ discovered: true, context: 65536, maxOutput: 4096, priceIn: 0, priceOut: 0, family: 'acme' })
    expect(s.registry.getModel('openrouter/acme/paid-chat')).toBeUndefined()
    expect(s.registry.getModel('openrouter/acme/content-safety:free')).toBeUndefined()
    expect(s.registry.getModel('openrouter/acme/music:free')).toBeUndefined()
    expect(s.registry.getModel('openrouter/acme/unpriced')).toBeUndefined()
    // the model from providers.md stays
    expect(s.registry.getModel('openrouter/google/gemini-2.5-flash')).toBeDefined()
  })

  it('keeps the discovered models over a reload, minus what discover_skip excludes', async () => {
    const s = await seededRegistry({ fetchImpl: routedFetch([['openrouter.ai', OPENROUTER_LIST]]) })
    cleanups.push(s.cleanup)
    await s.registry.discover()
    await s.registry.load()
    expect(s.registry.getModel('openrouter/acme/free-chat:free')?.discovered).toBe(true)
    const file = path.join(s.dir, 'config', 'providers.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('discover_skip: [content-safety]', 'discover_skip: [content-safety, free-chat]'), 'utf8')
    await s.registry.load()
    expect(s.registry.getModel('openrouter/acme/free-chat:free')).toBeUndefined()
  })

  it('a paid provider with discover: true only gets models that list a price', async () => {
    const s = await seededRegistry({ fetchImpl: routedFetch([['openrouter.ai', OPENROUTER_LIST]]) })
    cleanups.push(s.cleanup)
    const file = path.join(s.dir, 'config', 'providers.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('discover: free ', 'discover: true '), 'utf8')
    await s.registry.load()
    await s.registry.discover()
    expect(s.registry.getModel('openrouter/acme/paid-chat')).toMatchObject({ priceIn: 1, priceOut: 2 })
    expect(s.registry.getModel('openrouter/acme/unpriced')).toBeUndefined()
  })

  it('LM Studio discovery leaves out discover_skip words and takes the loaded context', async () => {
    const fetchImpl = routedFetch([
      ['/api/v0/models', { data: [{ id: 'qwen-test', loaded_context_length: 16384 }] }],
      ['localhost:1234', { data: [{ id: 'qwen-test' }, { id: 'dflash-draft' }] }]
    ])
    const s = await seededRegistry({ fetchImpl })
    cleanups.push(s.cleanup)
    await s.registry.discover()
    expect(s.registry.getModel('lmstudio/qwen-test')).toBeDefined()
    expect(s.registry.getModel('lmstudio/dflash-draft')).toBeUndefined()
    // lmstudio loads models itself (load_models), so the loaded window is the one planned with
    expect(s.registry.contextLength('lmstudio/qwen-test')).toBe(16384)
  })

  it('catalog lists every chat model of a provider with its price, without the skipped and non-text ones', async () => {
    const s = await seededRegistry({ fetchImpl: routedFetch([['openrouter.ai', OPENROUTER_LIST]]) })
    cleanups.push(s.cleanup)
    const list = await s.registry.catalog('openrouter')
    expect(list.map((m) => m.id)).toEqual(['acme/free-chat:free', 'acme/paid-chat', 'acme/unpriced'])
    await expect(s.registry.catalog('nope')).rejects.toThrow(/no provider/)
    await expect(s.registry.catalog('anthropic')).rejects.toThrow(/can't list/)
  })
})

describe('config/models.md', () => {
  async function withModelsMd(front: string) {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    await fs.writeFile(path.join(s.dir, 'config', 'models.md'), `---\nkind: models\n${front}---\n# Models\n`, 'utf8')
    await s.registry.load()
    return s
  }

  it('is optional: nothing picked, hidden or limited without it', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    expect(s.registry.modelChoices).toEqual({ kind: 'models', picked: [], hidden: [], limits: {} })
    expect(s.registry.isShown('deepseek/deepseek-flash')).toBe(true)
  })

  it('adds the picked models with their price, and hides the hidden ones from the pickers', async () => {
    const s = await withModelsMd(
      'picked:\n  - { provider: openrouter, id: acme/paid-chat, context: 32000, price_in: 1, price_out: 2 }\n  - { provider: nope, id: x, price_in: 0, price_out: 0 }\n' + 'hidden: [deepseek/deepseek-v4-pro]\n'
    )
    const m = s.registry.getModel('openrouter/acme/paid-chat')!
    expect(m).toMatchObject({ picked: true, context: 32000, priceIn: 1, priceOut: 2, priceCachedIn: 1, family: 'acme' })
    expect(s.registry.getModel('nope/x')).toBeUndefined()
    expect(s.registry.isShown('deepseek/deepseek-v4-pro')).toBe(false)
    expect(s.registry.isShown('deepseek/deepseek-flash')).toBe(true)
    // hidden is only for the pickers: the model still exists
    expect(s.registry.getModel('deepseek/deepseek-v4-pro')).toBeDefined()
  })

  it('providers.md wins for a model that is in both', async () => {
    const s = await withModelsMd('picked:\n  - { provider: openrouter, id: google/gemini-2.5-flash, price_in: 9, price_out: 9 }\n')
    expect(s.registry.getModel('openrouter/google/gemini-2.5-flash')).toMatchObject({ priceIn: 0.3, priceOut: 2.5 })
    expect(s.registry.getModel('openrouter/google/gemini-2.5-flash')?.picked).toBeUndefined()
  })

  it('limits win over providers.md, and 0 means no limit', async () => {
    const s = await withModelsMd('limits:\n  openrouter: { rpm: 0, rpd: 7 }\n  deepseek: { concurrency: 2, rpm: 30 }\n')
    expect(s.registry.providers.get('openrouter')).toMatchObject({ rpm: undefined, rpd: 7 })
    expect(s.registry.providers.get('deepseek')).toMatchObject({ concurrency: 2, rpm: 30 })
    // untouched: providers.md
    expect(s.registry.providers.get('openai')).toMatchObject({ concurrency: 4 })
  })

  it('an invalid file throws and keeps the previous state', async () => {
    const s = await withModelsMd('hidden: [deepseek/deepseek-v4-pro]\n')
    await fs.writeFile(path.join(s.dir, 'config', 'models.md'), '---\nkind: models\nhidden: 5\n---\n', 'utf8')
    await expect(s.registry.load()).rejects.toThrow()
    expect(s.registry.isShown('deepseek/deepseek-v4-pro')).toBe(false)
  })
})

describe('config reload', () => {
  it('sees an edit of providers.md, and not before it', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    expect(await s.registry.configChanged()).toBe(false)
    const file = path.join(s.dir, 'config', 'providers.md')
    const text = await fs.readFile(file, 'utf8')
    const edited = text.replace(/(id: client[\s\S]*?claude-code[\s\S]*?context: )200000/, (_m, head: string) => `${head}100000`)
    expect(edited).not.toBe(text)
    await fs.writeFile(file, edited)
    const later = new Date(Date.now() + 5000)
    await fs.utimes(file, later, later)
    expect(await s.registry.configChanged()).toBe(true)
    expect(s.registry.contextLength('client/claude-code')).toBe(200000)
    await s.registry.load()
    expect(await s.registry.configChanged()).toBe(false)
    expect(s.registry.contextLength('client/claude-code')).toBe(100000)
  })

  it('keeps a broken file from being tried again once it is marked seen, and sees the fix', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const file = path.join(s.dir, 'config', 'providers.md')
    const good = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, '---\nkind: providers\nproviders: [unclosed\n---\n')
    expect(await s.registry.configChanged()).toBe(true)
    const sig = await s.registry.configSignature()
    await expect(s.registry.load()).rejects.toThrow()
    expect(await s.registry.configChanged()).toBe(true)
    s.registry.markConfigSeen(sig)
    expect(await s.registry.configChanged()).toBe(false)
    expect(s.registry.getModel('mock/mock-translator')).toBeDefined()
    await fs.writeFile(file, good)
    expect(await s.registry.configChanged()).toBe(true)
  })

  it('keeps the context LM Studio reported across a reload', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    s.registry.getModel('deepseek/deepseek-flash')!.loadedContext = 32768
    await s.registry.load()
    expect(s.registry.contextLength('deepseek/deepseek-flash')).toBe(32768)
  })
})

describe('concurrency: auto and server slots', () => {
  const LMS = 'http://localhost:1234/api/v1/models'

  it('starts auto providers at 1 and not down', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    expect(s.registry.providers.get('strata')).toMatchObject({ concurrencyAuto: true, concurrency: 1, down: false })
    expect(s.registry.providers.get('lmstudio')).toMatchObject({ concurrencyAuto: true, loadModels: true, discoverSkip: ['dflash'] })
    expect(s.registry.providers.get('deepseek')).toMatchObject({ concurrencyAuto: false, concurrency: 8 })
  })

  it('takes the Strata slot count from /status concurrency.serving, capped at 16', async () => {
    let serving = 4
    const fetchImpl = routedFetch([
      ['127.0.0.1:8080', () => new Response(JSON.stringify({ loaded: true, concurrency: { serving } }), { status: 200 })],
      ['localhost:1234', () => new Response('{}', { status: 404 })]
    ])
    const s = await seededRegistry({ fetchImpl })
    cleanups.push(s.cleanup)
    const changed = await s.registry.syncServerSlots()
    expect(changed.find((c) => c.provider.id === 'strata')).toMatchObject({ from: 1, to: 4 })
    expect(s.registry.providers.get('strata')).toMatchObject({ concurrency: 4, down: false })
    expect((await s.registry.syncServerSlots()).find((c) => c.provider.id === 'strata')).toBeUndefined()
    serving = 99
    await s.registry.syncServerSlots()
    expect(s.registry.providers.get('strata')!.concurrency).toBe(16)
    // kept across a config reload
    await s.registry.load()
    expect(s.registry.providers.get('strata')!.concurrency).toBe(16)
  })

  it('sums the parallel of the loaded LM Studio chat models', async () => {
    const lm = {
      models: [
        { key: 'a', type: 'llm', loaded_instances: [{ id: 'a', config: { parallel: 2 } }, { id: 'a:2', config: { parallel: 3 } }] },
        { key: 'b', type: 'llm', loaded_instances: [{ id: 'b' }] },
        { key: 'emb', type: 'embedding', loaded_instances: [{ id: 'emb', config: { parallel: 8 } }] },
        { key: 'c', type: 'llm', loaded_instances: [] }
      ]
    }
    const s = await seededRegistry({ fetchImpl: routedFetch([[LMS, lm], ['127.0.0.1:8080', () => new Response('{}', { status: 404 })]]) })
    cleanups.push(s.cleanup)
    await s.registry.syncServerSlots()
    expect(s.registry.providers.get('lmstudio')).toMatchObject({ concurrency: 6, down: false })
  })

  it('marks a server that does not answer as down with 1 slot, and up again when it answers', async () => {
    let up = true
    const fetchImpl = (async (url: string | URL | Request) => {
      if (!up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      if (String(url).includes('8080')) return new Response(JSON.stringify({ concurrency: { serving: 4 } }), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const s = await seededRegistry({ fetchImpl })
    cleanups.push(s.cleanup)
    await s.registry.syncServerSlots()
    expect(s.registry.providers.get('strata')).toMatchObject({ concurrency: 4, down: false })
    up = false
    const changed = await s.registry.syncServerSlots()
    expect(changed.find((c) => c.provider.id === 'strata')).toMatchObject({ from: 4, to: 1 })
    expect(s.registry.providers.get('strata')).toMatchObject({ concurrency: 1, down: true })
    // kept across a reload
    await s.registry.load()
    expect(s.registry.providers.get('strata')!.down).toBe(true)
    up = true
    await s.registry.syncServerSlots()
    expect(s.registry.providers.get('strata')).toMatchObject({ concurrency: 4, down: false })
  })

  it('a Strata with its model unloaded and no auto_load counts as down', async () => {
    const fetchImpl = routedFetch([['127.0.0.1:8080', { loaded: false, auto_load: false }], ['localhost:1234', () => new Response('{}', { status: 404 })]])
    const s = await seededRegistry({ fetchImpl })
    cleanups.push(s.cleanup)
    await s.registry.syncServerSlots()
    expect(s.registry.providers.get('strata')!.down).toBe(true)
  })

  it('markDown marks an auto server at once, and only an auto one', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const strata = s.registry.providers.get('strata')!
    expect(s.registry.markDown(strata)).toBe(true)
    expect(s.registry.markDown(strata)).toBe(false)
    expect(s.registry.markDown(s.registry.providers.get('deepseek')!)).toBe(false)
    await s.registry.load()
    expect(s.registry.providers.get('strata')!.down).toBe(true)
  })
})

describe('group aliases and order', () => {
  const lmLoad = { parallel: 4, context: 131072, ttlMinutes: 60 }

  it('resolves an alias to its default and leaves provider/model alone', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    s.registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, lmLoad })
    expect(s.registry.resolve('paid')).toBe('deepseek/deepseek-flash')
    expect(s.registry.resolve('strata')).toBe('strata/qwen3.8-flash-next')
    expect(s.registry.resolve('lmstudio')).toBe('lmstudio') // no default set: left as it is
    expect(s.registry.resolve('openai/gpt-5')).toBe('openai/gpt-5')
  })

  it('knows the group of an alias or a model', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    s.registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash' }, lmLoad })
    expect(s.registry.groupOf('paid')).toBe('paid')
    expect(s.registry.groupOf('deepseek/deepseek-v4-pro')).toBe('paid')
    expect(s.registry.groupOf('strata/qwen3.8-flash-next')).toBe('strata')
    expect(s.registry.groupOf('lmstudio/x')).toBe('lmstudio')
    expect(s.registry.groupOf('ollama/x')).toBeUndefined()
  })

  it('orderRefs keeps the list as it is without an order, else sorts by group and keeps the order inside a group', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const list = ['paid', 'strata', 'lmstudio/x', 'openai/gpt-5', 'deepseek/deepseek-v4-pro', 'ollama/y']
    s.registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, lmLoad })
    expect(s.registry.orderRefs(list)).toEqual(list)
    s.registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, order: ['strata', 'paid'], lmLoad })
    // lmstudio is not in the order and ollama is in no group: both go last, in their own order
    expect(s.registry.orderRefs(list)).toEqual(['strata', 'paid', 'openai/gpt-5', 'deepseek/deepseek-v4-pro', 'lmstudio/x', 'ollama/y'])
    s.registry.setDefaults({ aliases: { paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next' }, order: ['lmstudio', 'strata', 'paid'], lmLoad })
    expect(s.registry.orderRefs(list)).toEqual(['lmstudio/x', 'strata', 'paid', 'openai/gpt-5', 'deepseek/deepseek-v4-pro', 'ollama/y'])
  })

  it('takes the aliases, order and load settings from a defaults.json', async () => {
    const d = defaultsSchema.parse({ groupDefaults: { paid: 'deepseek/deepseek-flash', lmstudio: '' }, modelOrder: ['strata'], lmstudio: { parallel: 2 } })
    expect(modelDefaultsOf(d)).toEqual({
      aliases: { paid: 'deepseek/deepseek-flash' },
      order: ['strata'],
      lmLoad: { parallel: 2, context: 131072, ttlMinutes: 60 }
    })
    // the seed has them too
    const seed = defaultsSchema.parse(JSON.parse(await fs.readFile(path.join(SEED_DIR, 'config', 'defaults.json'), 'utf8')))
    expect(seed).toMatchObject({ modelOrder: [], lmstudio: { parallel: 4 }, parallel: { enabled: true, maxAtOnce: 'auto', splitSections: false } })
    expect(seed.groupDefaults.paid).toBe('deepseek/deepseek-flash')
  })

  it('loadConfigFor uses the model\'s own load settings over the defaults', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const file = path.join(s.dir, 'config', 'providers.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n').replace('    models: []\n  - id: strata', '    models:\n      - { id: big, family: qwen, load_context: 65536, load_parallel: 2 }\n  - id: strata'), 'utf8')
    s.registry.setDefaults({ aliases: {}, lmLoad: { parallel: 4, context: 131072, ttlMinutes: 30 } })
    await s.registry.load()
    expect(s.registry.loadConfigFor('lmstudio', 'big')).toEqual({ parallel: 2, context: 65536, ttlMinutes: 30 })
    expect(s.registry.loadConfigFor('lmstudio', 'other')).toEqual({ parallel: 4, context: 131072, ttlMinutes: 30 })
    // a model the engine loads is planned with the window it is loaded with
    expect(s.registry.contextLength('lmstudio/big')).toBe(65536)
  })
})
