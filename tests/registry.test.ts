import { afterEach, describe, expect, it } from 'vitest'
import { computeCost, ModelRegistry } from '../src/engine/models/registry'
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
    expect(ids).toEqual(expect.arrayContaining(['deepseek', 'openai', 'openrouter', 'anthropic', 'gemini', 'lmstudio', 'ollama', 'custom', 'mock']))
    expect(s.registry.getModel('mock/mock-translator')).toBeDefined()
    expect(s.registry.getModel('mock/mock-reviewer')).toBeDefined()
    expect(s.registry.providers.get('ollama')!.available).toBe(false)
    expect(s.registry.providers.get('custom')!.available).toBe(false)
    expect(s.registry.providers.get('mock')!.available).toBe(true)
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
    const m = s.registry.getModel('deepseek/deepseek-v4-flash')!
    expect(computeCost(m, { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(0.42, 6)
  })

  it('reports the effective context: loaded, then providers.md, then 8192', async () => {
    const s = await seededRegistry()
    cleanups.push(s.cleanup)
    const r = s.registry
    expect(r.contextLength('deepseek/deepseek-v4-flash')).toBe(1_000_000)
    expect(r.contextLength('mock/mock-translator')).toBe(8192)
    expect(r.contextLength('unknown/model')).toBe(8192)
    r.getModel('deepseek/deepseek-v4-flash')!.loadedContext = 32768
    expect(r.contextLength('deepseek/deepseek-v4-flash')).toBe(32768)
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
