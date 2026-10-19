import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandDispatcher, serveEngine } from '../src/engine/dispatcher'
import { ModelRegistry } from '../src/engine/models/registry'
import { ProviderError } from '../src/engine/models/types'
import type { DefaultsConfig } from '../src/shared/schemas'
import type { AnalyzeResult, CatalogResult, Command, EngineEvent, EngineTransport, ModelsInfo, PrepareChunksResult, ProjectDetail, Request, SubmitResult, TranslationTask } from '../src/shared/protocol'
import type { ChunkRecord, ProjectSummary } from '../src/shared/project'
import { asSegs, lastUser, MODEL, QA_MODEL, rig, segsIn } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

let r: Rig | undefined
afterEach(async () => {
  await r?.cleanup()
  r = undefined
})

const MODELS = { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] }

async function setup(opts: { keys?: Record<string, string>; fetchImpl?: typeof fetch } = {}) {
  r = await rig({ fetchImpl: opts.fetchImpl })
  const stored: Record<string, string> = { ...(opts.keys ?? {}) }
  const emitted: EngineEvent[] = []
  const dispatcher = new CommandDispatcher({
    service: r.service,
    emit: (ev) => void emitted.push(ev),
    showMock: true,
    keys: (name) => stored[name],
    storeKey: (name, value) => {
      stored[name] = value
    }
  })
  const run = <T>(cmd: Command) => dispatcher.handle(cmd) as Promise<T>
  const waitFor = async (pred: () => boolean, ms = 8000) => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting for events')
      await new Promise((res) => setTimeout(res, 10))
    }
  }
  return { r, dispatcher, run, stored, waitFor, emitted }
}

describe('command dispatcher', () => {
  it('createProject -> analyze -> start -> progress events -> export', async () => {
    const { r, run, waitFor } = await setup()

    const analysis = await run<AnalyzeResult>({ type: 'analyze', sourcePath: r.file, targetLanguage: 'Croatian', settings: { agentModels: MODELS, maxChunkTokens: 100, enabled: { glossary: false, proofreader: false, qa: false } } })
    expect(analysis.file.format).toBe('md')
    expect(analysis.file.title).toBe('Test Book')
    expect(analysis.file.words).toBeGreaterThan(100)
    expect(analysis.file.outputExt).toBe('.md')
    expect(analysis.estimate.chunks).toBeGreaterThan(3)
    // a file analysis creates nothing
    expect(await run<ProjectSummary[]>({ type: 'snapshot' })).toBeUndefined()
    expect((r.events.find((e) => e.type === 'snapshot') as { projects: unknown[] }).projects).toHaveLength(0)

    const project = await run<ProjectSummary>({
      type: 'createProject',
      sourcePath: r.file,
      targetLanguage: 'Croatian',
      settings: { agentModels: MODELS, maxChunkTokens: 100, enabled: { glossary: false, proofreader: false, qa: false } }
    })
    expect(project.format).toBe('md')
    const forProject = await run<AnalyzeResult>({ type: 'analyze', projectId: project.id })
    expect(forProject.estimate.chunks).toBe(analysis.estimate.chunks)

    expect(await run({ type: 'start', projectId: project.id })).toBeUndefined()
    await waitFor(() => r.events.some((e) => e.type === 'project.updated' && e.project.status === 'done'))
    const progress = r.events.filter((e): e is Extract<EngineEvent, { type: 'progress' }> => e.type === 'progress')
    expect(progress.length).toBeGreaterThan(2)
    expect(progress[progress.length - 1]).toMatchObject({ done: analysis.estimate.chunks, total: analysis.estimate.chunks })
    expect(r.events.some((e) => e.type === 'chunk.token')).toBe(true)

    const detail = await run<ProjectDetail>({ type: 'getProject', projectId: project.id })
    expect(detail.chunks).toHaveLength(analysis.estimate.chunks)
    expect(detail.chunks.every((c) => c.state === 'done')).toBe(true)
    expect(detail.running).toBe(false)
    expect(detail.sections.length).toBeGreaterThan(0)

    const exported = await run<{ path: string; rel: string | null }>({ type: 'export', projectId: project.id })
    expect(exported.rel).toBe(`projects/${project.id}/output/book.hr.md`)
    expect(await fs.readFile(exported.path, 'utf8')).toContain('[hr] Paragraph 1 of chapter 1')
  })

  it('chunk detail, edit, glossary and delete', async () => {
    const { r, run, waitFor } = await setup()
    const p = await run<ProjectSummary>({ type: 'createProject', sourcePath: r.file, targetLanguage: 'hr', settings: { agentModels: MODELS, maxChunkTokens: 100, enabled: { glossary: false, proofreader: false, qa: false } } })
    await run({ type: 'start', projectId: p.id })
    await waitFor(() => r.events.some((e) => e.type === 'project.updated' && e.project.status === 'done'))

    const chunk = await run<ChunkRecord>({ type: 'getChunk', projectId: p.id, index: 1 })
    expect(chunk.segments.length).toBeGreaterThan(0)
    const seg = chunk.segments[0]!
    const edited = await run<ChunkRecord>({ type: 'editChunk', projectId: p.id, index: 1, final: { [seg.id]: 'Moj tekst' } })
    expect(edited.final[seg.id]).toBe('Moj tekst')
    expect(edited.edited).toBe(true)
    await expect(run({ type: 'editChunk', projectId: p.id, index: 1, final: { nope: 'x' } })).rejects.toThrow(/no segment/)

    await run({ type: 'updateGlossary', projectId: p.id, entries: [{ source: 'Alice', target: 'Alisa', type: 'person' }] })
    expect((await run<ProjectDetail>({ type: 'getProject', projectId: p.id })).glossary).toEqual([expect.objectContaining({ source: 'Alice', target: 'Alisa' })])

    await run({ type: 'retryChunk', projectId: p.id, index: 2 })
    await waitFor(() => !r.service.isRunning(p.id))
    expect((await run<ChunkRecord>({ type: 'getChunk', projectId: p.id, index: 2 })).state).toBe('done')

    await run({ type: 'deleteProject', projectId: p.id })
    expect(r.events.some((e) => e.type === 'project.deleted' && e.projectId === p.id)).toBe(true)
    await expect(run({ type: 'getProject', projectId: p.id })).rejects.toThrow()
  })

  it('pause and resume', async () => {
    const { r, run, waitFor } = await setup()
    const p = await run<ProjectSummary>({ type: 'createProject', sourcePath: r.file, targetLanguage: 'hr', settings: { agentModels: MODELS, maxChunkTokens: 100, enabled: { glossary: false, proofreader: false, qa: false } } })
    await run({ type: 'start', projectId: p.id })
    await waitFor(() => r.events.some((e) => e.type === 'chunk.state' && e.state === 'done'))
    await run({ type: 'pause', projectId: p.id })
    expect(r.events.some((e) => e.type === 'project.updated' && e.project.status === 'paused')).toBe(true)
    await run({ type: 'resume', projectId: p.id })
    await waitFor(() => r.events.some((e) => e.type === 'project.updated' && e.project.status === 'done'))
  })

  it('lists models (mock hidden unless asked), saves providers, stores secrets', async () => {
    const { r, run } = await setup({ keys: { DEEPSEEK_API_KEY: 'abc' } })
    const info = await run<ModelsInfo>({ type: 'listModels' })
    const ds = info.providers.find((p) => p.id === 'deepseek')!
    expect(ds).toMatchObject({ hasKey: true, available: true, local: false, concurrency: 8 })
    const model = info.models.find((m) => m.ref === 'deepseek/deepseek-flash')!
    expect(model).toMatchObject({ context: 1000000, priceIn: 0.3, local: false })
    expect(info.providers.find((p) => p.id === 'anthropic')).toMatchObject({ hasKey: false })
    expect(info.models.some((m) => m.ref.startsWith('mock/'))).toBe(true)
    const hidden = new CommandDispatcher({ service: r.service, emit: () => undefined, keys: () => undefined })
    expect((await hidden.handle({ type: 'listModels' }) as ModelsInfo).models.some((m) => m.ref.startsWith('mock/'))).toBe(false)

    // a secret goes to the store, never into the reply
    const after = await run<ModelsInfo>({ type: 'setSecret', name: 'ANTHROPIC_API_KEY', value: ' sk-secret ' })
    expect(after.providers.find((p) => p.id === 'anthropic')).toMatchObject({ hasKey: true })
    expect(JSON.stringify(after)).not.toContain('sk-secret')
    await expect(run({ type: 'setSecret', name: 'NOT_A_KEY', value: 'x' })).rejects.toThrow(/no provider uses/)

    const saved = await run<ModelsInfo>({ type: 'saveProviders', providers: [{ id: 'deepseek', enabled: false, concurrency: 3 }, { id: 'ollama', enabled: true, baseUrl: 'http://localhost:9999/v1' }] })
    expect(saved.providers.find((p) => p.id === 'deepseek')).toMatchObject({ enabled: false, concurrency: 3, available: false })
    expect(saved.providers.find((p) => p.id === 'ollama')).toMatchObject({ enabled: true, baseUrl: 'http://localhost:9999/v1' })
    const text = await fs.readFile(path.join(r.dir, 'config', 'providers.md'), 'utf8')
    expect(text).toContain('# to verify')
    expect(text).toContain('## Fields of a provider')
    await expect(run({ type: 'saveProviders', providers: [{ id: 'nope', enabled: true }] })).rejects.toThrow(/unknown provider/)
    await expect(run({ type: 'saveProviders', providers: [{ id: 'ollama', concurrency: 0 }] })).rejects.toThrow(/concurrency/)
  })

  it('reads and writes the defaults', async () => {
    const { run } = await setup()
    const d = await run<{ agentModels: Record<string, string[]>; languages: unknown[]; defaultMaxChunkTokens: number }>({ type: 'getDefaults' })
    expect(d.languages.length).toBeGreaterThan(10)
    expect(d.agentModels.translator?.[0]).toBe('strata/qwen3.8-flash-next')
    const next = await run<typeof d>({ type: 'setDefaults', patch: { agentModels: { qa: ['mock/mock-reviewer'] }, defaultMaxChunkTokens: 900 } })
    expect(next.agentModels.qa).toEqual(['mock/mock-reviewer'])
    expect(next.agentModels.translator).toEqual(d.agentModels.translator)
    expect(next.defaultMaxChunkTokens).toBe(900)
    expect(next.languages).toHaveLength(d.languages.length)
  })

  it('answers requests over a transport with correlated replies', async () => {
    const { dispatcher } = await setup()
    const sent: EngineEvent[] = []
    let handler: ((m: Request) => void) | undefined
    const transport: EngineTransport = {
      send: (m) => void sent.push(m),
      onMessage: (h) => {
        handler = h
        return () => undefined
      },
      close: () => undefined
    }
    serveEngine(transport, dispatcher)
    handler!({ id: 7, command: { type: 'getInfo' } })
    handler!({ id: 8, command: { type: 'getProject', projectId: 'missing' } })
    handler!({ id: 9, command: { type: 'listModels' } })
    const start = Date.now()
    while (sent.filter((e) => e.type === 'reply').length < 3 && Date.now() - start < 3000) await new Promise((res) => setTimeout(res, 10))
    const replies = Object.fromEntries(sent.filter((e) => e.type === 'reply').map((e) => [e.id, e]))
    expect(replies[7]).toMatchObject({ ok: true, result: { extensions: expect.arrayContaining(['.epub', '.pdf']) } })
    expect(replies[8]).toMatchObject({ ok: false })
    expect(replies[9]).toMatchObject({ ok: true })
  })
})

describe('models dialog commands', () => {
  const LISTING = {
    data: [
      { id: 'acme/free-chat:free', context_length: 65536, top_provider: { max_completion_tokens: 4096 }, pricing: { prompt: '0', completion: '0' } },
      { id: 'acme/paid-chat', context_length: 32000, pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001' } },
      { id: 'acme/unpriced' }
    ]
  }
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('openrouter.ai')) return new Response(JSON.stringify(LISTING), { status: 200 })
    if (u.includes('127.0.0.1:8080/v1/status')) return new Response(JSON.stringify({ loaded: true, concurrency: { serving: 4 } }), { status: 200 })
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  }) as typeof fetch

  async function modelsSetup() {
    const s = await setup({ fetchImpl })
    // a client with the stub (a registry reload makes a new one with the registry's own fetch, which is the same stub)
    return s
  }

  it('detectModels lists what a provider has, with prices, and what can be picked', async () => {
    const { run } = await modelsSetup()
    const res = await run<CatalogResult>({ type: 'detectModels', provider: 'openrouter' })
    expect(res.provider).toBe('openrouter')
    expect(res.models).toEqual([
      { id: 'acme/free-chat:free', ref: 'openrouter/acme/free-chat:free', context: 65536, priceIn: 0, priceOut: 0, pickable: true },
      { id: 'acme/paid-chat', ref: 'openrouter/acme/paid-chat', context: 32000, priceIn: expect.closeTo(1, 6), priceOut: expect.closeTo(2, 6), pickable: true },
      { id: 'acme/unpriced', ref: 'openrouter/acme/unpriced', context: undefined, priceIn: undefined, priceOut: undefined, pickable: false }
    ])
    await expect(run({ type: 'detectModels', provider: 'nope' })).rejects.toThrow(/no provider/)
    await expect(run({ type: 'detectModels', provider: 'anthropic' })).rejects.toThrow(/can't list/)
    // a server that does not answer
    await expect(run({ type: 'detectModels', provider: 'lmstudio' })).rejects.toThrow()
  })

  it('showModels ticks a listed model into config/models.md with its listed price, and unticks it again', async () => {
    const { r, run } = await modelsSetup()
    await run({ type: 'detectModels', provider: 'openrouter' })
    const info = await run<ModelsInfo>({ type: 'showModels', provider: 'openrouter', refs: ['openrouter/acme/paid-chat', 'openrouter/acme/free-chat:free'], show: true })
    expect(info.models.find((m) => m.ref === 'openrouter/acme/paid-chat')).toMatchObject({ picked: true, shown: true, context: 32000, priceOut: expect.closeTo(2, 6) })
    expect(info.models.find((m) => m.ref === 'openrouter/acme/free-chat:free')).toMatchObject({ picked: true, priceIn: 0, maxOutput: 4096 })
    const text = await fs.readFile(path.join(r.dir, 'config', 'models.md'), 'utf8')
    expect(text).toContain('kind: models')
    expect(text).toContain('acme/paid-chat')
    expect(text).toContain('# Models in the pickers')
    // unticking a picked model removes it
    const after = await run<ModelsInfo>({ type: 'showModels', provider: 'openrouter', refs: ['openrouter/acme/paid-chat'], show: false })
    expect(after.models.some((m) => m.ref === 'openrouter/acme/paid-chat')).toBe(false)
    expect(after.models.some((m) => m.ref === 'openrouter/acme/free-chat:free')).toBe(true)
  })

  it('showModels hides and shows a model of providers.md, keeping the text of models.md', async () => {
    const { r, run } = await modelsSetup()
    const file = path.join(r.dir, 'config', 'models.md')
    await fs.writeFile(file, '---\nkind: models\npicked: []\nhidden: []\nlimits: {}\n---\nMy own notes.\n', 'utf8')
    const hidden = await run<ModelsInfo>({ type: 'showModels', provider: 'deepseek', refs: ['deepseek/deepseek-v4-pro'], show: false })
    expect(hidden.models.find((m) => m.ref === 'deepseek/deepseek-v4-pro')).toMatchObject({ shown: false, picked: false })
    expect(hidden.models.find((m) => m.ref === 'deepseek/deepseek-flash')).toMatchObject({ shown: true })
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('deepseek/deepseek-v4-pro')
    expect(text).toContain('My own notes.')
    const shown = await run<ModelsInfo>({ type: 'showModels', provider: 'deepseek', refs: ['deepseek/deepseek-v4-pro'], show: true })
    expect(shown.models.find((m) => m.ref === 'deepseek/deepseek-v4-pro')).toMatchObject({ shown: true })
  })

  it('showModels refuses an unknown provider, a foreign ref, an undetected model and a paid model without a price', async () => {
    const { run } = await modelsSetup()
    await expect(run({ type: 'showModels', provider: 'nope', refs: ['nope/x'], show: true })).rejects.toThrow(/no provider/)
    await expect(run({ type: 'showModels', provider: 'openrouter', refs: ['deepseek/deepseek-v4-pro'], show: false })).rejects.toThrow(/not a model of/)
    await expect(run({ type: 'showModels', provider: 'openrouter', refs: ['openrouter/acme/paid-chat'], show: true })).rejects.toThrow(/detect/)
    await run({ type: 'detectModels', provider: 'openrouter' })
    await expect(run({ type: 'showModels', provider: 'openrouter', refs: ['openrouter/acme/unpriced'], show: true })).rejects.toThrow(/no listed price/)
  })

  it('addModel adds a model by its id; a paid provider needs both prices', async () => {
    const { r, run } = await modelsSetup()
    await expect(run({ type: 'addModel', provider: 'openrouter', id: 'acme/new' })).rejects.toThrow(/price/)
    await expect(run({ type: 'addModel', provider: 'openrouter', id: 'acme/new', priceIn: 1 })).rejects.toThrow(/price/)
    await expect(run({ type: 'addModel', provider: 'openrouter', id: 'acme/new', priceIn: -1, priceOut: 1 })).rejects.toThrow(/price/)
    await expect(run({ type: 'addModel', provider: 'nope', id: 'x', priceIn: 0, priceOut: 0 })).rejects.toThrow(/no provider/)
    await expect(run({ type: 'addModel', provider: 'openrouter', id: '  ', priceIn: 0, priceOut: 0 })).rejects.toThrow(/empty/)
    const info = await run<ModelsInfo>({ type: 'addModel', provider: 'openrouter', id: ' acme/new ', priceIn: 0.5, priceOut: 1.5, context: 50000 })
    expect(info.models.find((m) => m.ref === 'openrouter/acme/new')).toMatchObject({ picked: true, priceIn: 0.5, priceOut: 1.5, context: 50000 })
    // a local provider needs no price
    const local = await run<ModelsInfo>({ type: 'addModel', provider: 'lmstudio', id: 'my-model' })
    expect(local.models.find((m) => m.ref === 'lmstudio/my-model')).toMatchObject({ picked: true, priceIn: 0, priceOut: 0 })
    // it survives a restart: a new registry reads models.md
    const again = new ModelRegistry(r.dir, { keys: () => 'k' })
    await again.load()
    expect(again.getModel('openrouter/acme/new')).toMatchObject({ priceIn: 0.5, priceOut: 1.5, picked: true })
  })

  it('addModel shows a hidden model again instead of adding it twice', async () => {
    const { run } = await modelsSetup()
    await run({ type: 'showModels', provider: 'deepseek', refs: ['deepseek/deepseek-v4-pro'], show: false })
    const info = await run<ModelsInfo>({ type: 'addModel', provider: 'deepseek', id: 'deepseek-v4-pro', priceIn: 1, priceOut: 1 })
    expect(info.models.filter((m) => m.ref === 'deepseek/deepseek-v4-pro')).toHaveLength(1)
    expect(info.models.find((m) => m.ref === 'deepseek/deepseek-v4-pro')).toMatchObject({ shown: true, picked: false, priceIn: 1.32 })
  })

  it('setProviderLimits saves limits over providers.md (0 means none) and frees waiting requests', async () => {
    const { r, run } = await modelsSetup()
    const info = await run<ModelsInfo>({ type: 'setProviderLimits', provider: 'openrouter', rpm: 0, rpd: 7, concurrency: 2 })
    expect(info.providers.find((p) => p.id === 'openrouter')).toMatchObject({ rpm: undefined, rpd: 7, concurrency: 2 })
    const text = await fs.readFile(path.join(r.dir, 'config', 'models.md'), 'utf8')
    expect(text).toMatch(/openrouter:/)
    // a field left out keeps its value
    const next = await run<ModelsInfo>({ type: 'setProviderLimits', provider: 'openrouter', rpm: 10 })
    expect(next.providers.find((p) => p.id === 'openrouter')).toMatchObject({ rpm: 10, rpd: 7, concurrency: 2 })
    // an auto server keeps the slot count its server reports
    const strata = await run<ModelsInfo>({ type: 'setProviderLimits', provider: 'strata', concurrency: 9, rpm: 5 })
    expect(strata.providers.find((p) => p.id === 'strata')).toMatchObject({ concurrencyAuto: true, concurrency: 1, rpm: 5 })
    await expect(run({ type: 'setProviderLimits', provider: 'nope', rpd: 1 })).rejects.toThrow(/no provider/)

    // a waiting request goes on when the limit is raised
    const p = r.service.registry.providers.get('deepseek')!
    p.concurrency = 1
    const limiter = r.service.router.limiter
    await limiter.acquire(p)
    let got = false
    void limiter.acquire(p).then(() => (got = true))
    await run({ type: 'setProviderLimits', provider: 'deepseek', concurrency: 3 })
    await new Promise((res) => setTimeout(res, 10))
    expect(got).toBe(true)
  })

  it('reports the daily count, the limit and a used-up day in the provider summaries', async () => {
    const { r, run } = await modelsSetup()
    const or = r.service.registry.providers.get('openrouter')!
    r.service.router.limiter.noteRequest(or)
    r.service.router.limiter.markDayFull(or)
    const info = await run<ModelsInfo>({ type: 'listModels' })
    expect(info.providers.find((p) => p.id === 'openrouter')).toMatchObject({ requestsToday: 1, dayFull: true, rpm: 20, rpd: 50, discover: 'free', loadModels: false })
    expect(info.providers.find((p) => p.id === 'openrouter')!.dayResetsAt).toBeGreaterThan(Date.now())
    expect(info.providers.find((p) => p.id === 'lmstudio')).toMatchObject({ loadModels: true, concurrencyAuto: true, down: false })
    expect(info.providers.find((p) => p.id === 'deepseek')).toMatchObject({ dayFull: false, requestsToday: 0, concurrencyAuto: false })
  })

  it('checkServers asks the auto servers now and sends the models event', async () => {
    const { r, run, emitted } = await modelsSetup()
    expect(r.service.registry.providers.get('strata')!.concurrency).toBe(1)
    const info = await run<ModelsInfo>({ type: 'checkServers' })
    expect(info.providers.find((p) => p.id === 'strata')).toMatchObject({ concurrency: 4, down: false })
    // lmstudio does not answer
    expect(info.providers.find((p) => p.id === 'lmstudio')).toMatchObject({ concurrency: 1, down: true })
    expect(emitted.some((e) => e.type === 'models')).toBe(true)
    expect(emitted.some((e) => e.type === 'log' && /lmstudio is down/.test(e.message))).toBe(true)
  })

  it('tells the UI when a request finds a server down or a daily limit used up', async () => {
    const { r, emitted } = await modelsSetup()
    const registry = r.service.registry
    registry.providers.get('strata')!.client = {
      id: 'strata',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new ProviderError('network error: fetch failed (ECONNREFUSED)', undefined, true, undefined, true)
      }
    }
    registry.providers.get('openrouter')!.client = {
      id: 'openrouter',
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new ProviderError('HTTP 429: free-models-per-day', 429, true)
      }
    }
    await r.service.router.complete(['strata/qwen3.8-flash-next', 'openrouter/google/gemini-2.5-flash', 'mock/mock-translator'], { messages: [{ role: 'user', content: 'x' }], meta: { role: 'translator' } })
    expect(emitted.filter((e) => e.type === 'models')).toHaveLength(2)
    expect(emitted.some((e) => e.type === 'log' && /strata is down/.test(e.message))).toBe(true)
    expect(emitted.some((e) => e.type === 'log' && /openrouter reached its daily limit/.test(e.message))).toBe(true)
  })

  it('saveProviders accepts concurrency auto, and refuses other words', async () => {
    const { r, run } = await modelsSetup()
    const saved = await run<ModelsInfo>({ type: 'saveProviders', providers: [{ id: 'deepseek', concurrency: 'auto' }, { id: 'strata', concurrency: 2 }] })
    expect(saved.providers.find((p) => p.id === 'deepseek')).toMatchObject({ concurrencyAuto: true })
    expect(saved.providers.find((p) => p.id === 'strata')).toMatchObject({ concurrencyAuto: false, concurrency: 2 })
    const text = (await fs.readFile(path.join(r.dir, 'config', 'providers.md'), 'utf8')).replace(/\r\n/g, '\n')
    expect(text).toMatch(/id: deepseek[\s\S]*?concurrency: auto/)
    expect(text).toContain('# to verify')
    await expect(run({ type: 'saveProviders', providers: [{ id: 'ollama', concurrency: 'fast' as unknown as 'auto' }] })).rejects.toThrow(/concurrency/)
  })

  it('setSecret asks the provider for its models again (OpenRouter lists free ones once it has a key)', async () => {
    const { run } = await setup({ fetchImpl })
    const before = await run<ModelsInfo>({ type: 'listModels' })
    expect(before.models.some((m) => m.ref === 'openrouter/acme/free-chat:free')).toBe(false)
    const after = await run<ModelsInfo>({ type: 'setSecret', name: 'OPENROUTER_API_KEY', value: 'sk-or' })
    expect(after.models.find((m) => m.ref === 'openrouter/acme/free-chat:free')).toMatchObject({ discovered: true, priceIn: 0, context: 65536 })
    expect(after.models.some((m) => m.ref === 'openrouter/acme/paid-chat')).toBe(false)
  })
})

describe('group defaults in defaults.json', () => {
  it('setDefaults merges groupDefaults, modelOrder, lmstudio and parallel, and the registry follows', async () => {
    const { r, run } = await setup()
    const d = await run<DefaultsConfig>({ type: 'getDefaults' })
    expect(d).toMatchObject({ modelOrder: [], lmstudio: { parallel: 4, context: 131072, ttlMinutes: 60 }, parallel: { enabled: true, maxAtOnce: 'auto', splitSections: false } })
    expect(d.groupDefaults.paid).toBe('deepseek/deepseek-flash')
    const next = await run<DefaultsConfig>({
      type: 'setDefaults',
      patch: {
        groupDefaults: { lmstudio: 'lmstudio/gemma' },
        modelOrder: ['strata', 'paid', 'lmstudio'],
        lmstudio: { parallel: 2 },
        parallel: { splitSections: true, maxAtOnce: 5 }
      }
    })
    expect(next.groupDefaults).toEqual({ paid: 'deepseek/deepseek-flash', strata: 'strata/qwen3.8-flash-next', lmstudio: 'lmstudio/gemma' })
    expect(next.modelOrder).toEqual(['strata', 'paid', 'lmstudio'])
    expect(next.lmstudio).toEqual({ parallel: 2, context: 131072, ttlMinutes: 60 })
    expect(next.parallel).toEqual({ enabled: true, maxAtOnce: 5, splitSections: true })
    expect(next.languages.length).toBeGreaterThan(10)
    const reg = r.service.registry
    expect(reg.resolve('lmstudio')).toBe('lmstudio/gemma')
    expect(reg.orderRefs(['paid', 'strata'])).toEqual(['strata', 'paid'])
    expect(reg.loadConfigFor('lmstudio', 'x')).toEqual({ parallel: 2, context: 131072, ttlMinutes: 60 })
    // an empty string takes an alias default away; an empty order means each list keeps its own
    const cleared = await run<DefaultsConfig>({ type: 'setDefaults', patch: { groupDefaults: { lmstudio: '' }, modelOrder: [] } })
    expect(cleared.groupDefaults).not.toHaveProperty('lmstudio')
    expect(cleared.modelOrder).toEqual([])
    expect(reg.resolve('lmstudio')).toBe('lmstudio')
  })

  it('setDefaults refuses invalid values and writes nothing', async () => {
    const { r, run } = await setup()
    const file = path.join(r.dir, 'config', 'defaults.json')
    const before = await fs.readFile(file, 'utf8')
    await expect(run({ type: 'setDefaults', patch: { parallel: { maxAtOnce: 99 } } })).rejects.toThrow(/invalid/)
    await expect(run({ type: 'setDefaults', patch: { lmstudio: { context: 100 } } })).rejects.toThrow(/invalid/)
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('new projects take the parallel defaults', async () => {
    const { r, run } = await setup()
    await run({ type: 'setDefaults', patch: { parallel: { enabled: false, maxAtOnce: 2, splitSections: true } } })
    const p = await run<ProjectSummary>({ type: 'createProject', sourcePath: r.file, targetLanguage: 'hr', settings: { agentModels: MODELS } })
    const detail = await run<ProjectDetail>({ type: 'getProject', projectId: p.id })
    expect(detail.project.settings.parallel).toEqual({ enabled: false, maxAtOnce: 2, splitSections: true })
  })
})

describe('updateProjectSettings', () => {
  it('changes models, agents and parallel of a project, merges partial patches and returns the detail', async () => {
    const { r, run } = await setup()
    const p = await run<ProjectSummary>({ type: 'createProject', sourcePath: r.file, targetLanguage: 'hr', settings: { agentModels: MODELS, maxChunkTokens: 100 } })
    const detail = await run<ProjectDetail>({
      type: 'updateProjectSettings',
      projectId: p.id,
      patch: { agentModels: { translator: ['mock/mock-reviewer', 'mock/mock-translator'] } as never, enabled: { qa: false, glossary: false, proofreader: false }, parallel: { splitSections: true, maxAtOnce: 2, enabled: true }, pauseAfterGlossary: true }
    })
    expect(detail.project.id).toBe(p.id)
    expect(detail.project.settings.agentModels.translator).toEqual(['mock/mock-reviewer', 'mock/mock-translator'])
    expect(detail.project.settings.agentModels.qa).toEqual([QA_MODEL])
    expect(detail.project.settings).toMatchObject({ enabled: { qa: false }, parallel: { splitSections: true, maxAtOnce: 2, enabled: true }, pauseAfterGlossary: true, maxChunkTokens: 100 })
    // a partial parallel patch keeps the rest
    const next = await run<ProjectDetail>({ type: 'updateProjectSettings', projectId: p.id, patch: { parallel: { enabled: false } as never } })
    expect(next.project.settings.parallel).toEqual({ enabled: false, maxAtOnce: 2, splitSections: true })
    // saved to project.json
    const saved = JSON.parse(await fs.readFile(path.join(r.dir, 'projects', p.id, 'project.json'), 'utf8')) as { settings: { parallel: unknown } }
    expect(saved.settings.parallel).toEqual({ enabled: false, maxAtOnce: 2, splitSections: true })
    await expect(run({ type: 'updateProjectSettings', projectId: 'missing', patch: {} })).rejects.toThrow()
  })

  it('is refused while the project runs, and works after a pause', async () => {
    const { r, run, waitFor } = await setup()
    r.mock.on({ role: 'translator' }, async (req) => {
      await new Promise((res) => setTimeout(res, 30))
      return asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: s.text })))
    })
    const p = await run<ProjectSummary>({ type: 'createProject', sourcePath: r.file, targetLanguage: 'hr', settings: { agentModels: MODELS, maxChunkTokens: 100, enabled: { glossary: false, proofreader: false, qa: false } } })
    await run({ type: 'start', projectId: p.id })
    await waitFor(() => r.service.isRunning(p.id))
    await expect(run({ type: 'updateProjectSettings', projectId: p.id, patch: { maxChunkTokens: 200 } })).rejects.toThrow(/pause/)
    expect((await run<ProjectDetail>({ type: 'getProject', projectId: p.id })).project.settings.maxChunkTokens).toBe(100)
    await run({ type: 'pause', projectId: p.id })
    const detail = await run<ProjectDetail>({ type: 'updateProjectSettings', projectId: p.id, patch: { pauseAfterGlossary: true } })
    expect(detail.project.settings.pauseAfterGlossary).toBe(true)
    expect(detail.running).toBe(false)
  })
})

describe('external translator commands (prepareChunks, getTranslationTask, submitTranslation, setBrief)', () => {
  const NO_AGENTS = { glossary: false, proofreader: false, qa: false }

  async function project(opts: { content?: string } = {}) {
    const s = await setup()
    if (opts.content) await fs.writeFile(s.r.file, opts.content, 'utf8')
    // no translator model at all: nothing here may need one
    const p = await s.run<ProjectSummary>({ type: 'createProject', sourcePath: s.r.file, targetLanguage: 'Croatian', sourceLanguage: 'English', settings: { agentModels: { ...MODELS, translator: [] }, maxChunkTokens: 100, enabled: NO_AGENTS } })
    return { ...s, id: p.id }
  }

  /** The first chunk that follows another chunk of its own section (it has a paragraph text and a previous passage to carry). */
  const follower = (chunks: { index: number; sectionId: string }[]) => chunks.find((c, i) => i > 0 && chunks[i - 1]!.sectionId === c.sectionId)!

  it('prepareChunks makes the chunks without a model, keeps them, and plans again only while all are pending', async () => {
    const { r, run, id } = await project()
    const first = await run<PrepareChunksResult>({ type: 'prepareChunks', projectId: id })
    expect(first.chunks.length).toBeGreaterThan(3)
    expect(first.chunks.every((c) => c.state === 'pending')).toBe(true)
    expect(r.mock.calls).toHaveLength(0)
    expect((await r.service.store.listChunks(id)).length).toBe(first.chunks.length)
    expect((await r.service.getProject(id)).chunking).toEqual({ budget: first.budget, chunks: first.chunks.length })
    expect(r.events.some((e) => e.type === 'project.updated' && e.project.id === id && e.project.chunks === first.chunks.length)).toBe(true)
    // the same call keeps the chunks
    expect((await run<PrepareChunksResult>({ type: 'prepareChunks', projectId: id })).chunks).toHaveLength(first.chunks.length)
    // a bigger chunk size while all are pending makes fewer chunks
    const bigger = await run<PrepareChunksResult>({ type: 'prepareChunks', projectId: id, maxChunkTokens: 400 })
    expect(bigger.budget).toBeGreaterThan(first.budget)
    expect(bigger.chunks.length).toBeLessThan(first.chunks.length)
    // once a chunk is translated the chunks stay
    const task = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id })
    await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, reply: asSegs(task.segmentIds.map((sid) => ({ id: sid, text: 'x' }))) })
    expect((await run<PrepareChunksResult>({ type: 'prepareChunks', projectId: id, maxChunkTokens: 100 })).chunks).toHaveLength(bigger.chunks.length)
    await expect(run({ type: 'prepareChunks', projectId: id, maxChunkTokens: 5 })).rejects.toThrow(/at least 100/)
  })

  it('getTranslationTask gives the translator messages: rules, brief, glossary slice, previous passage and the segments', async () => {
    const { r, run, id } = await project()
    await expect(run({ type: 'getTranslationTask', projectId: id })).rejects.toThrow(/prepareChunks/)
    const { chunks } = await run<PrepareChunksResult>({ type: 'prepareChunks', projectId: id })
    const f = follower(chunks).index
    await run({ type: 'updateGlossary', projectId: id, entries: [{ source: 'Alice', target: 'Alisa', type: 'person' }, { source: 'unicorn', target: 'jednorog', type: 'term' }] })
    await run({ type: 'setBrief', projectId: id, brief: 'Genre: light fiction\nTone: playful' })
    expect(await fs.readFile(path.join(r.dir, 'projects', id, 'brief.md'), 'utf8')).toContain('Tone: playful')

    const first = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id })
    expect(first.index).toBe(1)
    const one = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id, index: f - 1 })
    expect(one.index).toBe(f - 1)
    expect(one.messages.map((m) => m.role)).toEqual(['system', 'user'])
    const user = one.messages[1]!.content
    expect(segsIn(user).map((s) => s.id)).toEqual(one.segmentIds)
    expect(user).toContain('## Glossary')
    expect(user).toContain('Alisa')
    expect(user).not.toContain('jednorog')
    expect(one.messages[0]!.content).toContain('Tone: playful')
    expect(one.messages[0]!.content).toContain('Croatian')
    expect(one.remaining).toBe((await r.service.store.listChunks(id)).length)

    expect(user).not.toContain('Previous passage')
    await run({ type: 'submitTranslation', projectId: id, index: f - 1, reply: asSegs(one.segmentIds.map((sid) => ({ id: sid, text: `[hr] ${sid}` }))) })
    const two = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id, index: f })
    expect(two.index).toBe(f)
    expect(two.remaining).toBe(one.remaining - 1)
    // chunk 2 follows chunk 1 in the same section: its translated end comes as context
    expect(two.sectionId).toBe(one.sectionId)
    expect(two.messages[1]!.content).toContain('## Previous passage')
    expect(two.messages[1]!.content).toContain('[hr] ')
    // a given index works for any chunk, even a finished one; without an index the first unfinished chunk comes
    expect((await run<TranslationTask>({ type: 'getTranslationTask', projectId: id, index: f - 1 })).index).toBe(f - 1)
    expect((await run<TranslationTask>({ type: 'getTranslationTask', projectId: id })).index).toBe(1)
    await expect(run({ type: 'getTranslationTask', projectId: id, index: 999 })).rejects.toThrow(/no chunk 999/)
  })

  it('submitTranslation rejects wrong ids and saves nothing, accepts a good reply or map, and finishes the project', async () => {
    const { r, run, id } = await project()
    const prepared = await run<PrepareChunksResult>({ type: 'prepareChunks', projectId: id })
    const total = prepared.chunks.length
    const task = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id, index: follower(prepared.chunks).index })
    expect(task.segmentIds.length).toBeGreaterThan(1)
    const good = task.segmentIds.map((sid) => ({ id: sid, text: `[hr] ${sid}` }))

    const missing = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, reply: asSegs(good.slice(1)) })
    expect(missing).toMatchObject({ ok: false, state: 'pending', remaining: total })
    expect(missing.problems.join(' ')).toMatch(/missing or empty segments/)
    const extra = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, reply: asSegs([...good, { id: 'zzz', text: 'x' }]) })
    expect(extra.problems.join(' ')).toMatch(/not asked for: zzz/)
    const dup = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, reply: asSegs([...good, good[0]!]) })
    expect(dup.problems.join(' ')).toMatch(/repeated/)
    const mapMissing = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, segments: { [good[0]!.id]: 'only one' } })
    expect(mapMissing.ok).toBe(false)
    expect((await r.service.store.readChunk(id, task.index)).state).toBe('pending')
    await expect(run({ type: 'submitTranslation', projectId: id, index: task.index })).rejects.toThrow(/reply or a segments/)

    // a reply with chatter around the seg elements is fine
    const ok = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, reply: `Here you go:\n${asSegs(good)}\nDone.`, model: 'claude/test' })
    expect(ok).toEqual({ ok: true, state: 'done', problems: [], remaining: total - 1 })
    const saved = await r.service.store.readChunk(id, task.index)
    expect(saved).toMatchObject({ state: 'done', model: 'claude/test' })
    expect(saved.final).toEqual(Object.fromEntries(good.map((g) => [g.id, g.text])))
    expect(saved.translation).toEqual(saved.final)
    expect((await r.service.getProject(id)).status).toBe('incomplete')
    expect(r.events.some((e) => e.type === 'chunk.state' && e.projectId === id && e.index === task.index && e.state === 'done')).toBe(true)

    // the rest by id map, with the default model name
    for (;;) {
      const t = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id }).catch((e: Error) => e)
      if (t instanceof Error) {
        expect(t.message).toMatch(/nothing left/)
        break
      }
      const res = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: t.index, segments: Object.fromEntries(t.segmentIds.map((sid) => [sid, `[hr] ${sid}`])) })
      expect(res.ok).toBe(true)
    }
    expect((await r.service.getProject(id)).status).toBe('done')
    expect((await r.service.store.readChunk(id, 1)).model).toBe('external/mcp')
    expect(r.mock.calls).toHaveLength(0)
    const out = await run<{ path: string }>({ type: 'export', projectId: id })
    const text = await fs.readFile(out.path, 'utf8')
    expect(text).toContain('[hr] ')
    expect(text).not.toContain('Alice met Bob')
  })

  it('submitTranslation checks inline tags and says which segment is wrong', async () => {
    const { r, run, id } = await project({ content: '# Tagged\n\nThe <1>bold</1> word and one<2/> more.\n' })
    await run({ type: 'prepareChunks', projectId: id })
    const task = await run<TranslationTask>({ type: 'getTranslationTask', projectId: id })
    const source = segsIn(task.messages[1]!.content)
    const tagged = source.find((s) => /<\d+>/.test(s.text))!
    expect(tagged).toBeDefined()
    const bad = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, segments: Object.fromEntries(source.map((s) => [s.id, s === tagged ? 'no tags at all' : s.text])) })
    expect(bad.ok).toBe(false)
    expect(bad.problems.join(' ')).toContain(`segment ${tagged.id}`)
    expect(bad.problems.join(' ')).toMatch(/Inline tags do not match/)
    expect((await r.service.store.readChunk(id, task.index)).state).toBe('pending')
    const good = await run<SubmitResult>({ type: 'submitTranslation', projectId: id, index: task.index, segments: Object.fromEntries(source.map((s) => [s.id, `[hr] ${s.text}`])) })
    expect(good.ok).toBe(true)
  })

  it('is refused while the project runs in the app', async () => {
    const { r, run, id, waitFor } = await project()
    await run({ type: 'prepareChunks', projectId: id })
    r.mock.on({ role: 'translator' }, async (req) => {
      await new Promise((res) => setTimeout(res, 30))
      return asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: s.text })))
    })
    await run({ type: 'updateProjectSettings', projectId: id, patch: { agentModels: MODELS as never } })
    await run({ type: 'start', projectId: id })
    await waitFor(() => r.service.isRunning(id))
    await expect(run({ type: 'getTranslationTask', projectId: id })).rejects.toThrow(/pause/)
    await expect(run({ type: 'submitTranslation', projectId: id, index: 1, segments: {} })).rejects.toThrow(/pause/)
    await expect(run({ type: 'prepareChunks', projectId: id })).rejects.toThrow(/pause/)
    await run({ type: 'pause', projectId: id })
    expect((await run<TranslationTask>({ type: 'getTranslationTask', projectId: id })).index).toBeGreaterThan(0)
  })

  it('setBrief rejects an unknown project', async () => {
    const { run } = await setup()
    await expect(run({ type: 'setBrief', projectId: 'missing', brief: 'x' })).rejects.toThrow()
  })
})

describe('MCP settings and status', () => {
  it('defaults have mcp off on port 47811; setDefaults merges and validates it and calls the hook', async () => {
    const { r } = await setup()
    const calls: { before: DefaultsConfig; after: DefaultsConfig }[] = []
    const dispatcher = new CommandDispatcher({ service: r.service, emit: () => undefined, showMock: true, onDefaultsSaved: (before, after) => void calls.push({ before, after }) })
    const defaults = (await dispatcher.handle({ type: 'getDefaults' })) as DefaultsConfig
    expect(defaults.mcp).toEqual({ enabled: false, port: 47811 })
    expect(await dispatcher.handle({ type: 'getMcpStatus' })).toEqual({ enabled: false, running: false })
    const saved = (await dispatcher.handle({ type: 'setDefaults', patch: { mcp: { enabled: true } } })) as DefaultsConfig
    expect(saved.mcp).toEqual({ enabled: true, port: 47811 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.before.mcp.enabled).toBe(false)
    expect(calls[0]!.after.mcp.enabled).toBe(true)
    expect(await dispatcher.handle({ type: 'getMcpStatus' })).toEqual({ enabled: true, running: false })
    expect(((await dispatcher.handle({ type: 'setDefaults', patch: { mcp: { port: 50000 } } })) as DefaultsConfig).mcp).toEqual({ enabled: true, port: 50000 })
    await expect(dispatcher.handle({ type: 'setDefaults', patch: { mcp: { port: 80 } } })).rejects.toThrow(/mcp\.port/)
    // an old defaults.json without `mcp` still loads
    const file = path.join(r.dir, 'config', 'defaults.json')
    const old = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    delete old.mcp
    await fs.writeFile(file, JSON.stringify(old), 'utf8')
    expect(((await dispatcher.handle({ type: 'getDefaults' })) as DefaultsConfig).mcp).toEqual({ enabled: false, port: 47811 })
  })

  it('getMcpStatus asks the mcpStatus hook', async () => {
    const { r } = await setup()
    const dispatcher = new CommandDispatcher({ service: r.service, emit: () => undefined, mcpStatus: () => ({ enabled: true, running: true, url: 'http://127.0.0.1:1/mcp', token: 't' }) })
    expect(await dispatcher.handle({ type: 'getMcpStatus' })).toEqual({ enabled: true, running: true, url: 'http://127.0.0.1:1/mcp', token: 't' })
  })
})
