import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockProvider } from '../src/engine/models/mock'
import { collect } from '../src/engine/models/types'
import { mergeSettings } from '../src/engine/project/store'
import { AGENTS } from '../src/shared/agents'
import type { ProjectSettings } from '../src/shared/project'
import { rig, scriptMock } from './pipelineHelpers'
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

describe('independent reviewer in a client-only project', () => {
  /** A rig with the client provider on and the mock provider marked local (a free reviewer); a worker answers the client tasks. */
  async function reviewerRig() {
    let fetches = 0
    const rg = await rig({ fetchImpl: (() => {
        fetches++
        return Promise.reject(new TypeError('offline'))
      }) as unknown as typeof fetch })
    const file = path.join(rg.dir, 'config', 'providers.md')
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.replace(/(id: mock\r?\n\s+kind: mock\r?\n)/, '$1    local: true\n'), 'utf8')
    await rg.service.registry.load()
    expect(rg.service.registry.isLocalRef('mock/mock-reviewer')).toBe(true)
    const client = new MockProvider('client-answers', { chunkDelayMs: 1, chunks: 1 })
    scriptMock(client)
    let stop = false
    void (async () => {
      while (!stop) {
        const t = rg.service.clientQueue.lease()
        if (!t) {
          await new Promise((res) => setTimeout(res, 3))
          continue
        }
        const { text: answer } = await collect(client.chat({ model: 'mock-translator', messages: t.messages, schema: t.schema, meta: { role: t.role, task: t.task, project: t.project, unit: t.unit } }))
        rg.service.clientQueue.submit(t.id, answer)
      }
    })()
    return { rg, fetches: () => fetches, resetFetches: () => (fetches = 0), stop: () => (stop = true) }
  }
  const all = { glossary: false, proofreader: false, qa: true }

  it('sends QA to the reviewer and nothing else, and a reviewer that is down never lets another model in', async () => {
    const w = await reviewerRig()
    r = w.rg
    try {
      r.mock.on({ role: 'qa' }, '{"score":9,"issues":[]}')
      const id = await r.create({ clientOnly: true, reviewer: { models: ['mock/mock-reviewer'] }, enabled: all })
      const p = await r.service.store.load(id)
      expect(p.settings.agentModels).toMatchObject({ qa: ['mock/mock-reviewer'], translator: CLIENT, glossary: CLIENT, proofreader: CLIENT })
      expect((await r.service.start(id)).status).toBe('done')
      expect(r.mock.calls.length).toBeGreaterThan(0)
      expect(r.mock.calls.every((c) => c.meta?.role === 'qa' && c.model === 'mock-reviewer')).toBe(true)
      const chunks = await r.service.store.listChunks(id)
      expect(chunks.every((c) => c.qa.score === 9 && c.qa.model === 'mock/mock-reviewer')).toBe(true)
      expect((await r.service.detail(id)).qa).toMatchObject({ score: 9, independent: true })

      // the reviewer goes down while the shared fallbacks are on: no other model is called, QA falls back to the deterministic checks
      r.service.registry.setDefaults({ fallbacks: ['mock/mock-translator', 'deepseek/deepseek-flash'], shared: true, lmLoad: { parallel: 1, context: 8192, ttlMinutes: 30 } })
      r.mock.reset()
      r.mock.on({ role: 'qa' }, () => {
        throw new Error('reviewer is down')
      })
      w.resetFetches()
      await r.service.retryChunk(id, 1)
      expect(r.mock.calls.length).toBeGreaterThan(0)
      expect(r.mock.calls.every((c) => c.meta?.role === 'qa' && c.model === 'mock-reviewer')).toBe(true)
      expect(w.fetches()).toBe(0)
      const retried = (await r.service.store.listChunks(id))[0]!
      expect(['done', 'flagged']).toContain(retried.state)
      expect(retried.qa.score).toBeUndefined()
      expect(await fs.readFile(r.service.store.file(id, 'log.md'), 'utf8')).toMatch(/QA model gave no usable answer/)
    } finally {
      w.stop()
    }
  })

  it('refuses a reviewer that is not free when saved, and at call time', async () => {
    const w = await reviewerRig()
    r = w.rg
    try {
      for (const models of [['deepseek/deepseek-chat'], ['client/claude-code'], ['nowhere/x']]) {
        await expect(r.create({ clientOnly: true, reviewer: { models } })).rejects.toThrow(models[0] === 'client/claude-code' ? /different model/ : /not free/)
      }
      const id = await r.create({ clientOnly: true, enabled: all })
      expect(() => r!.service.checkReviewer({ reviewer: { models: ['deepseek/deepseek-chat'] } })).toThrow(/not free/)
      // saved by hand: the reviewer is paid
      const p = await r.service.store.load(id)
      p.settings.reviewer = { models: ['deepseek/deepseek-chat'] }
      p.settings.agentModels.qa = ['deepseek/deepseek-chat']
      await r.service.store.save(p)
      w.resetFetches()
      expect((await r.service.start(id)).status).toBe('done')
      expect(r.mock.calls.length).toBe(0)
      expect(w.fetches()).toBe(0)
      expect(await fs.readFile(r.service.store.file(id, 'log.md'), 'utf8')).toMatch(/client-only/)
      expect((await r.service.store.listChunks(id)).every((c) => c.qa.score === undefined)).toBe(true)
    } finally {
      w.stop()
    }
  })
})
