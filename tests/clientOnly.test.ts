import { afterEach, describe, expect, it } from 'vitest'
import { mergeSettings } from '../src/engine/project/store'
import { AGENTS } from '../src/shared/agents'
import type { ProjectSettings } from '../src/shared/project'
import { rig } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

let r: Rig | undefined
afterEach(async () => {
  await r?.cleanup()
  r = undefined
})

const CLIENT = ['client/claude-code']
const base: ProjectSettings = {
  targetLanguage: 'Croatian',
  agentModels: { glossary: ['paid'], translator: ['deepseek/deepseek-chat'], proofreader: ['strata/x'], qa: ['mock/mock-reviewer'] },
  enabled: { glossary: true, proofreader: true, qa: true },
  maxChunkTokens: 1500,
  pauseAfterGlossary: false,
  parallel: { enabled: true, maxAtOnce: 'auto', splitSections: false }
}

describe('clientOnly settings', () => {
  it('sets all four agents to the client model and ignores agentModels given with it', () => {
    const s = mergeSettings(base, { clientOnly: true, agentModels: { translator: ['paid'] } as never })
    expect(s.clientOnly).toBe(true)
    for (const a of AGENTS) expect(s.agentModels[a], a).toEqual(CLIENT)
  })

  it('keeps the client when settings are merged into a client-only project later', () => {
    const on = mergeSettings(base, { clientOnly: true })
    const later = mergeSettings(on, { agentModels: { translator: ['paid'], qa: ['mock/mock-reviewer'] } as never, maxChunkTokens: 200 })
    expect(later.clientOnly).toBe(true)
    expect(later.maxChunkTokens).toBe(200)
    for (const a of AGENTS) expect(later.agentModels[a], a).toEqual(CLIENT)
  })

  it('turning it off lets agentModels change again', () => {
    const on = mergeSettings(base, { clientOnly: true })
    const off = mergeSettings(on, { clientOnly: false, agentModels: { translator: ['mock/mock-translator'] } as never })
    expect(off.clientOnly).toBe(false)
    expect(off.agentModels.translator).toEqual(['mock/mock-translator'])
    expect(off.agentModels.glossary).toEqual(CLIENT) // stays until set
  })
})

describe('clientOnly projects (engine)', () => {
  it('create_project sets the client everywhere, and an existing project keeps it when merged again', async () => {
    r = await rig()
    const id = await r.create({ clientOnly: true })
    let p = await r.service.store.load(id)
    for (const a of AGENTS) expect(p.settings.agentModels[a], a).toEqual(CLIENT)
    const again = await r.create({ maxChunkTokens: 120 }) // same file and language: settings merged into the existing project
    expect(again).toBe(id)
    p = await r.service.store.load(id)
    expect(p.settings.clientOnly).toBe(true)
    expect(p.settings.maxChunkTokens).toBe(120)
    for (const a of AGENTS) expect(p.settings.agentModels[a], a).toEqual(CLIENT)
  })

  it('refuses a non-client ref that reaches the call path (old settings), without calling it', async () => {
    r = await rig()
    const id = await r.create()
    const p = await r.service.store.load(id)
    p.settings.clientOnly = true // saved by hand: the translator still has a mock model
    await r.service.store.save(p)
    const res = await r.service.start(id)
    expect(res.status).not.toBe('done')
    expect(r.mock.calls.length).toBe(0)
    const chunks = await r.service.store.listChunks(id)
    expect(chunks.some((c) => /client-only/.test(c.error ?? ''))).toBe(true)
  })

  it('refuses retry_chunk with a non-client model, and works normally once it is off', async () => {
    r = await rig()
    const id = await r.create()
    expect((await r.service.start(id)).status).toBe('done')
    const before = r.mock.calls.length
    const p = await r.service.store.load(id)
    p.settings.clientOnly = true
    await r.service.store.save(p)
    const res = await r.service.retryChunk(id, 1, 'mock/mock-reviewer')
    expect(res.status).not.toBe('done')
    expect(r.mock.calls.length).toBe(before)

    const q = await r.service.store.load(id)
    q.settings = mergeSettings(q.settings, { clientOnly: false, agentModels: { translator: ['mock/mock-translator'] } as never })
    await r.service.store.save(q)
    expect((await r.service.retryChunk(id, 1)).status).toBe('done')
    expect(r.mock.calls.length).toBeGreaterThan(before)
  })
})
