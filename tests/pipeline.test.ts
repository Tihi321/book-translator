import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRequest } from '../src/engine/models/types'
import { ProviderError } from '../src/engine/models/types'
import { parseGlossary } from '../src/engine/pipeline/glossary'
import { asSegs, lastUser, rig, segsIn } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

let r: Rig | undefined
afterEach(async () => {
  await r?.cleanup()
  r = undefined
})

const echo = (req: ChatRequest, prefix = '[hr] ') => asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: prefix + s.text })))
const unitOf = (req: ChatRequest) => req.meta?.unit

describe('pipeline end to end (mock models)', () => {
  it('runs glossary, translator, proofreader and QA, then exports', async () => {
    r = await rig()
    const id = await r.create({ enabled: { glossary: true, proofreader: true, qa: true } })

    const est = await r.service.analyze(id)
    expect(est.chunks).toBeGreaterThan(4)
    expect(est.sourceTokens).toBeGreaterThan(100)
    expect(est.perAgent.translator).toBeDefined()
    expect(est.perAgent.qa).toBeDefined()
    expect(est.estSeconds).toBeGreaterThan(0)

    const res = await r.service.start(id)
    expect(res.status).toBe('done')
    expect(res.counts.done).toBe(est.chunks)
    expect(res.spend.tokensIn).toBeGreaterThan(0)

    const store = r.service.store
    const glossary = await fs.readFile(store.file(id, 'glossary.md'), 'utf8')
    expect(parseGlossary(glossary).map((e) => e.target)).toContain('Alisa')
    expect(await fs.readFile(store.file(id, 'brief.md'), 'utf8')).toContain('Genre: fiction')
    for (const role of ['glossary', 'translator', 'proofreader', 'qa']) expect(r.calls(role).length, role).toBeGreaterThan(0)
    const project = await store.load(id)
    expect(project.status).toBe('done')
    expect(project.glossaryDone).toBe(true)
    expect(project.spend.tokensIn).toBe(res.spend.tokensIn)

    const out = await r.service.export(id)
    expect(path.basename(out)).toBe('book.hr.md')
    const text = await fs.readFile(out, 'utf8')
    expect(text).toContain('[hr] Paragraph 1 of chapter 1: Alice met Bob')
    expect(text).toContain('✓')
    expect(text).toContain('```js\nconst code = 1\n```') // meta block carried through
    expect(text).toContain('[hr] ## Chapter 2')

    const stages = new Set(r.events.filter((e) => e.type === 'chunk.state').map((e) => (e.type === 'chunk.state' ? e.state : '')))
    for (const s of ['translating', 'proofreading', 'reviewing', 'done']) expect(stages.has(s as never), s).toBe(true)
    expect(r.events.some((e) => e.type === 'chunk.token')).toBe(true)
    const last = [...r.events].reverse().find((e) => e.type === 'progress')
    expect(last).toMatchObject({ type: 'progress', done: est.chunks, total: est.chunks })

    // a second start does nothing: every chunk is done and the glossary is built
    const before = r.mock.calls.length
    expect((await r.service.start(id)).status).toBe('done')
    expect(r.mock.calls.length).toBe(before)
  })

  it('stops after the glossary when asked, and continues without building it again', async () => {
    r = await rig()
    const id = await r.create({ enabled: { glossary: true, proofreader: false, qa: false }, pauseAfterGlossary: true })
    expect((await r.service.start(id)).status).toBe('glossary-review')
    expect(r.calls('translator')).toHaveLength(0)
    expect(r.calls('glossary')).toHaveLength(1)
    await r.service.updateGlossary(id, [{ source: 'Alice', target: 'Alica', type: 'person' }])
    expect((await r.service.start(id)).status).toBe('done')
    expect(r.calls('glossary')).toHaveLength(1)
    expect(await fs.readFile(await r.service.export(id), 'utf8')).toContain('[hr]')
  })

  it('translates without the glossary when the builder cannot answer', async () => {
    r = await rig()
    r.mock.on({ role: 'glossary' }, 'I do not know JSON')
    const id = await r.create({ enabled: { glossary: true, proofreader: false, qa: false } })
    expect((await r.service.start(id)).status).toBe('done')
    expect((await r.service.getProject(id)).glossaryDone).toBe(false)
    expect(r.events.some((e) => e.type === 'error')).toBe(true)
  })

  it('creates the project files and the same project for the same file and language', async () => {
    r = await rig()
    const id = await r.create()
    const again = await r.create({ maxChunkTokens: 200 })
    expect(again).toBe(id)
    expect((await r.service.getProject(id)).settings.maxChunkTokens).toBe(200)
    const files = await fs.readdir(r.service.store.dir(id))
    expect(files.sort()).toEqual(['brief.md', 'chunks', 'glossary.md', 'log.md', 'output', 'project.json', 'source.json'])
    const list = await r.service.listProjects()
    expect(list.map((p) => p.id)).toEqual([id])
    expect(list[0]).toMatchObject({ format: 'md', targetLanguage: 'Croatian', status: 'created' })
    const ir = await r.service.store.readIr(id)
    expect(ir.sections.length).toBe(3)
  })

  it('makes chunks from the settings on start (and again while nothing has run)', async () => {
    r = await rig()
    const id = await r.create({ maxChunkTokens: 100 })
    await r.service.start(id)
    const small = (await r.service.store.listChunks(id)).length
    const id2 = await r.create({ maxChunkTokens: 300 })
    expect(id2).toBe(id)
    // everything is done, so the chunks stay as they are
    await r.service.start(id)
    expect((await r.service.store.listChunks(id)).length).toBe(small)
  })

  it('reports an unusable translator model', async () => {
    r = await rig()
    const id = await r.create({ agentModels: { translator: ['nope/none'], glossary: [], proofreader: [], qa: [] } })
    await expect(r.service.start(id)).rejects.toThrow(/no usable translator model/)
    expect(r.events.some((e) => e.type === 'error')).toBe(true)
  })
})

describe('resume', () => {
  it('pauses mid-run, exports partial progress, and resumes without asking again for finished chunks', async () => {
    let pause: () => void = () => undefined
    let dones = 0
    r = await rig({
      delay: 8,
      onEvent: (e) => {
        if (e.type === 'chunk.state' && e.state === 'done' && ++dones === 2) pause()
      }
    })
    const id = await r.create()
    const service = r.service
    pause = () => void service.pause(id)

    const first = await service.start(id)
    expect(first.status).toBe('paused')
    const mid = await service.store.listChunks(id)
    const done = mid.filter((c) => c.state === 'done').map((c) => c.index)
    expect(done.length).toBeGreaterThanOrEqual(2)
    expect(mid.some((c) => c.state === 'pending')).toBe(true)
    expect(mid.every((c) => c.state === 'done' || c.state === 'pending')).toBe(true) // in-progress chunks went back to pending
    expect((await service.getProject(id)).status).toBe('paused')

    // partial export: translated blocks and untouched source text together
    const partial = await fs.readFile(await service.export(id), 'utf8')
    expect(partial).toContain('[hr] ')
    expect(partial).toContain('\nParagraph 12 of chapter 2: Alice met Bob') // not translated yet: source text stays

    const second = await service.start(id)
    expect(second.status).toBe('done')
    const all = await service.store.listChunks(id)
    expect(all.every((c) => c.state === 'done')).toBe(true)
    for (const i of done) expect(r.calls('translator').filter((c) => c.unit === `chunk-${i}`), `chunk ${i}`).toHaveLength(1)
    const full = await fs.readFile(await service.export(id), 'utf8')
    expect(full).not.toContain('\nParagraph 12 of chapter 2')
    expect(full).toContain('[hr] Paragraph 12 of chapter 2')
  })

  it('resets chunks left in progress by a crash and retries failed ones', async () => {
    r = await rig()
    const id = await r.create()
    await r.service.start(id)
    const chunks = await r.service.store.listChunks(id)
    chunks[0]!.state = 'proofreading'
    chunks[1]!.state = 'failed'
    for (const c of chunks.slice(0, 2)) await r.service.store.writeChunk(id, c)
    const before = r.calls('translator').length
    expect((await r.service.start(id)).status).toBe('done')
    expect(r.calls('translator').length - before).toBe(2)
  })

  it('cancel stops the run and marks the project cancelled', async () => {
    let cancel: () => void = () => undefined
    r = await rig({ delay: 8, onEvent: (e) => e.type === 'chunk.state' && e.state === 'translating' && cancel() })
    const id = await r.create()
    const service = r.service
    cancel = () => void service.cancel(id)
    expect((await service.start(id)).status).toBe('cancelled')
    expect((await service.getProject(id)).status).toBe('cancelled')
    expect((await service.store.listChunks(id)).every((c) => c.state === 'pending')).toBe(true)
  })
})

describe('translator retries', () => {
  it('retries once with a note when segments are missing', async () => {
    r = await rig()
    r.mock.on({ role: 'translator' }, (req) => {
      const segs = segsIn(lastUser(req))
      if (unitOf(req) === 'chunk-2' && req.meta?.task === 'translate') return asSegs(segs.slice(0, -1).map((s) => ({ id: s.id, text: `[hr] ${s.text}` })))
      return echo(req)
    })
    const id = await r.create()
    expect((await r.service.start(id)).status).toBe('done')
    expect(r.calls('translator').filter((c) => c.unit === 'chunk-2').map((c) => c.task)).toEqual(['translate', 'retry'])
  })

  it('splits the chunk in half when the retry fails too', async () => {
    r = await rig()
    r.mock.on({ role: 'translator' }, (req) => {
      const segs = segsIn(lastUser(req))
      if (unitOf(req) === 'chunk-2' && segs.length >= 3) return asSegs(segs.slice(1).map((s) => ({ id: s.id, text: `[hr] ${s.text}` })))
      return echo(req)
    })
    const id = await r.create()
    expect((await r.service.start(id)).status).toBe('done')
    const chunk = (await r.service.store.listChunks(id))[1]!
    expect(chunk.segments.length).toBeGreaterThanOrEqual(3)
    expect(r.calls('translator').filter((c) => c.unit === 'chunk-2').map((c) => c.task)).toEqual(['translate', 'retry', 'translate', 'translate'])
    expect(Object.keys(chunk.final)).toEqual(chunk.segments.map((s) => s.id))
    expect(Object.values(chunk.final).every((t) => t.startsWith('[hr] '))).toBe(true)
  })

  it('marks a chunk failed, carries on with the others, and retries it on request', async () => {
    r = await rig()
    const undo = r.mock.on({ role: 'translator' }, (req) => (unitOf(req) === 'chunk-3' ? 'garbage' : echo(req)))
    const id = await r.create()
    const res = await r.service.start(id)
    expect(res.status).toBe('incomplete')
    expect(res.counts.failed).toBe(1)
    const chunks = await r.service.store.listChunks(id)
    expect(chunks[2]!.state).toBe('failed')
    expect(chunks[2]!.error).toMatch(/did not return the segments correctly/)
    expect(chunks.filter((c) => c.state === 'done').length).toBe(chunks.length - 1)
    expect(r.events.some((e) => e.type === 'chunk.state' && e.state === 'failed' && e.index === 3)).toBe(true)

    // export works: the failed chunk's blocks keep the source text
    const text = await fs.readFile(await r.service.export(id), 'utf8')
    const failedText = chunks[2]!.segments[0]!.text
    expect(text).toContain(`\n${failedText}\n`)
    expect(text).toContain('[hr] ')

    undo()
    const retry = await r.service.retryChunk(id, 3)
    expect(retry.status).toBe('done')
    const after = await r.service.store.readChunk(id, 3)
    expect(after.state).toBe('done')
    expect(after.error).toBeUndefined()
    expect(after.final[after.segments[0]!.id]).toBe(`[hr] ${failedText}`)
  })

  it('fails a chunk on a provider error that is not retryable', async () => {
    r = await rig()
    r.mock.on({ role: 'translator' }, (req) => {
      if (unitOf(req) === 'chunk-1') throw new ProviderError('HTTP 400: bad request', 400, false)
      return echo(req)
    })
    const id = await r.create()
    const res = await r.service.start(id)
    expect(res.counts.failed).toBe(1)
    expect((await r.service.store.readChunk(id, 1)).error).toMatch(/400/)
  })

  it('retries a chunk with another model first', async () => {
    r = await rig()
    const undo = r.mock.on({ role: 'translator' }, (req) => (unitOf(req) === 'chunk-1' ? 'garbage' : echo(req)))
    const id = await r.create()
    await r.service.start(id)
    undo()
    await r.service.retryChunk(id, 1, 'mock/mock-reviewer')
    expect((await r.service.store.readChunk(id, 1)).model).toBe('mock/mock-reviewer')
  })
})

describe('proofreader and QA', () => {
  it('keeps the translation when the proofreader answers nonsense', async () => {
    r = await rig()
    r.mock.on({ role: 'proofreader' }, 'nonsense')
    const id = await r.create({ enabled: { glossary: false, proofreader: true, qa: false } })
    expect((await r.service.start(id)).status).toBe('done')
    const chunk = (await r.service.store.listChunks(id))[1]!
    expect(Object.values(chunk.final).every((t) => t.startsWith('[hr] ') && !t.includes('✓'))).toBe(true)
  })

  it('runs a fix pass for a major issue and re-checks once', async () => {
    r = await rig()
    r.mock.on({ role: 'qa' }, (req) => {
      const user = lastUser(req)
      const first = segsIn(user, 'pair')[0]!.id
      if (unitOf(req) !== 'chunk-2' || user.includes('[fixed]')) return '{"issues":[]}'
      return JSON.stringify({ issues: [{ segId: first, type: 'omission', severity: 'major', comment: 'A clause is missing.', suggestion: 'add it' }] })
    })
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true } })
    expect((await r.service.start(id)).status).toBe('done')
    const chunk = (await r.service.store.listChunks(id))[1]!
    const first = chunk.segments[0]!.id
    expect(chunk.final[first]).toBe(`[fixed] [hr] ${chunk.segments[0]!.text}`)
    expect(chunk.translation[first]).toBe(`[hr] ${chunk.segments[0]!.text}`)
    expect(chunk.qa.issues).toEqual([])
    expect(chunk.state).toBe('done')
    expect(r.calls('translator', 'fix').map((c) => c.unit)).toEqual(['chunk-2'])
    expect(r.calls('qa').filter((c) => c.unit === 'chunk-2').map((c) => c.task)).toEqual(['review', 'recheck'])
    expect(r.events.some((e) => e.type === 'chunk.state' && e.state === 'fixing' && e.index === 2)).toBe(true)
  })

  it('flags the chunk when a major issue remains after the fix pass', async () => {
    r = await rig()
    r.mock.on({ role: 'qa' }, (req) => {
      if (unitOf(req) !== 'chunk-2') return '{"issues":[]}'
      const first = segsIn(lastUser(req), 'pair')[0]!.id
      return JSON.stringify({ issues: [{ segId: first, type: 'mistranslation', severity: 'major', comment: 'Wrong meaning.' }, { segId: 'nonexistent', type: 'omission', severity: 'major', comment: 'ignored' }] })
    })
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true } })
    const res = await r.service.start(id)
    expect(res.status).toBe('done') // flagged chunks are finished chunks
    expect(res.counts.flagged).toBe(1)
    const chunk = (await r.service.store.listChunks(id))[1]!
    expect(chunk.state).toBe('flagged')
    expect(chunk.qa.issues).toHaveLength(1)
    expect(chunk.qa.issues[0]).toMatchObject({ type: 'mistranslation', severity: 'major' })
    expect(r.calls('translator', 'fix')).toHaveLength(1) // one fix pass only
    expect((await r.service.listProjects())[0]).toMatchObject({ flagged: 1 })
  })

  it('does not fix minor issues and stores them', async () => {
    r = await rig()
    r.mock.on({ role: 'qa' }, (req) => JSON.stringify({ issues: [{ segId: segsIn(lastUser(req), 'pair')[0]!.id, type: 'mistranslation', severity: 'minor', comment: 'Slightly off.' }] }))
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true } })
    expect((await r.service.start(id)).counts.flagged).toBe(0)
    expect(r.calls('translator', 'fix')).toHaveLength(0)
    expect((await r.service.store.listChunks(id))[0]!.qa.issues).toHaveLength(1)
  })

  it('uses deterministic checks when the QA model answers nonsense', async () => {
    r = await rig()
    r.mock.on({ role: 'qa' }, 'not json')
    r.mock.on({ role: 'translator' }, (req) => (req.meta?.task === 'fix' ? echo(req, '') : asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: s.text })))))
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true } })
    const res = await r.service.start(id)
    // the "translation" equals the source: untranslated, major, and the fix pass changes nothing
    expect(res.counts.flagged).toBeGreaterThan(0)
    expect((await r.service.store.listChunks(id))[1]!.qa.issues.some((i) => i.type === 'untranslated')).toBe(true)
  })
})

describe('editing', () => {
  it('lets the user edit a chunk and update the glossary', async () => {
    r = await rig()
    const id = await r.create()
    await r.service.start(id)
    const chunk = (await r.service.store.listChunks(id))[1]!
    const seg = chunk.segments[0]!.id
    const edited = await r.service.editChunk(id, 2, { [seg]: 'Ručno uređeno.' })
    expect(edited).toMatchObject({ state: 'done', edited: true })
    expect(await fs.readFile(await r.service.export(id), 'utf8')).toContain('Ručno uređeno.')
    await expect(r.service.editChunk(id, 2, { nope: 'x' })).rejects.toThrow(/no segment nope/)
    await r.service.updateGlossary(id, [{ source: 'Bob', target: 'Bobi', type: 'person' }])
    expect(await r.service.store.readGlossary(id)).toEqual([{ source: 'Bob', target: 'Bobi', type: 'person' }])
  })

  it('rejoins pieces of a split block on export', async () => {
    const sentence = 'The old oak tree stood in the garden for a hundred years.'
    r = await rig({ content: `# Book\n\n${Array.from({ length: 40 }, () => sentence).join(' ')}\n\nShort end.\n` })
    const id = await r.create({ maxChunkTokens: 120 })
    expect((await r.service.start(id)).status).toBe('done')
    const chunks = await r.service.store.listChunks(id)
    const ids = chunks.flatMap((c) => c.segments.map((s) => s.id))
    expect(ids.filter((i) => i.startsWith('b2#')).length).toBeGreaterThan(2)
    const text = await fs.readFile(await r.service.export(id), 'utf8')
    const para = text.split('\n\n').find((p) => p.includes('oak tree'))!
    expect(para.startsWith('[hr] ' + sentence)).toBe(true)
    expect(para.match(/\[hr\] /g)!.length).toBe(ids.filter((i) => i.startsWith('b2#')).length)
    expect(text).toContain('[hr] Short end.')
  })
})
