import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandDispatcher, serveEngine } from '../src/engine/dispatcher'
import type { AnalyzeResult, Command, EngineEvent, EngineTransport, ModelsInfo, ProjectDetail, Request } from '../src/shared/protocol'
import type { ChunkRecord, ProjectSummary } from '../src/shared/project'
import { MODEL, QA_MODEL, rig } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

let r: Rig | undefined
afterEach(async () => {
  await r?.cleanup()
  r = undefined
})

const MODELS = { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] }

async function setup(opts: { keys?: Record<string, string> } = {}) {
  r = await rig()
  const stored: Record<string, string> = { ...(opts.keys ?? {}) }
  const dispatcher = new CommandDispatcher({
    service: r.service,
    emit: () => undefined,
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
  return { r, dispatcher, run, stored, waitFor }
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
    const model = info.models.find((m) => m.ref === 'deepseek/deepseek-v4-flash')!
    expect(model).toMatchObject({ context: 1000000, priceIn: 0.14, local: false })
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
