import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRequest } from '../src/engine/models/types'
import { ProviderError } from '../src/engine/models/types'
import { parseGlossary } from '../src/engine/pipeline/glossary'
import { summarize } from '../src/engine/project/summary'
import { MODEL, QA_MODEL, asSegs, bookText, lastUser, rig, segsIn } from './pipelineHelpers'
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
    // the glossary pass writes the target language's typography default into the brief's settings
    expect(project.settings.typography).toMatchObject({ dialogue: 'dash' })
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

  it('keeps the brief the user set when the glossary pass returns another', async () => {
    r = await rig()
    const id = await r.create({ enabled: { glossary: true, proofreader: false, qa: false } })
    await r.service.setBrief(id, '- Tone: dry and cold\n- Rules: keep French lines as they are')
    expect((await r.service.start(id)).status).toBe('done')
    const brief = await fs.readFile(r.service.store.file(id, 'brief.md'), 'utf8')
    expect(brief).toContain('- Tone: dry and cold')
    expect(brief).toContain('keep French lines as they are')
    expect(brief).not.toContain('Tone: light')
    expect(brief).toContain('Genre: fiction')
  })

  it('translates without the glossary when the builder cannot answer', async () => {
    r = await rig()
    r.mock.on({ role: 'glossary' }, 'I do not know JSON')
    const id = await r.create({ enabled: { glossary: true, proofreader: false, qa: false } })
    expect((await r.service.start(id)).status).toBe('done')
    expect((await r.service.getProject(id)).glossaryDone).toBe(false)
    expect(r.events.some((e) => e.type === 'error')).toBe(true)
  })

  it('keeps the glossary of the other passes when one pass fails', async () => {
    // big enough for more than one glossary pass (6000 tokens each)
    r = await rig({ content: bookText(8, 60) })
    const good = r.mock
    good.on({ role: 'glossary' }, (req) =>
      req.meta?.unit === 'glossary-2' ? 'I do not know JSON' : JSON.stringify({ terms: [{ source: 'Alice', target: 'Alisa', type: 'person' }] })
    )
    const id = await r.create({ enabled: { glossary: true, proofreader: false, qa: false } })
    expect((await r.service.start(id)).status).toBe('done')
    const project = await r.service.getProject(id)
    expect(project.glossaryDone).toBe(true)
    const units = new Set(r.calls('glossary').map((c) => c.unit))
    expect(units.size).toBeGreaterThan(2)
    const glossary = await fs.readFile(r.service.store.file(id, 'glossary.md'), 'utf8')
    expect(parseGlossary(glossary).map((e) => e.target)).toContain('Alisa')
    const log = await fs.readFile(r.service.store.file(id, 'log.md'), 'utf8')
    expect(log).toMatch(/glossary pass 2 of \d+ failed, skipped/)
    expect(log).toMatch(/1 of them failed and were skipped/)
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
    const report = await service.exportWithReport(id, undefined, { allowPartial: true })
    expect(report.warnings).toEqual([expect.stringMatching(/stay in the source language: chunks? [\d, ]+ pending/)])
    const partial = await fs.readFile(report.path, 'utf8')
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

  it('a pause keeps the translation of a chunk that was proofreading, and the resume does not translate it again', async () => {
    let pause: () => void = () => undefined
    r = await rig({ delay: 8, onEvent: (e) => e.type === 'chunk.state' && e.state === 'proofreading' && e.index === 1 && pause() })
    const id = await r.create({ enabled: { glossary: false, proofreader: true, qa: false }, parallel: { enabled: false, maxAtOnce: 1, splitSections: false } })
    const service = r.service
    pause = () => {
      pause = () => undefined // only the first time
      void service.pause(id)
    }
    expect((await service.start(id)).status).toBe('paused')
    const parked = (await service.store.listChunks(id))[0]!
    expect(parked.state).toBe('pending')
    expect(Object.values(parked.translation)[0]).toContain('[hr] ')

    expect((await service.start(id)).status).toBe('done')
    expect(r.calls('translator').filter((c) => c.unit === 'chunk-1')).toHaveLength(1)
    expect(r.calls('proofreader').filter((c) => c.unit === 'chunk-1').length).toBeGreaterThan(0)
    expect(Object.values((await service.store.readChunk(id, 1)).final)[0]).toContain('✓')
  })

  it('a pause inside the translator keeps the accepted first half of a split chunk, and the resume asks only for the second half', async () => {
    r = await rig({ delay: 8, content: 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.\n' })
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: false }, maxChunkTokens: 1000, parallel: { enabled: false, maxAtOnce: 1, splitSections: false } })
    const service = r.service
    const asked: string[][] = []
    let pausedOnce = false
    r.mock.on({ role: 'translator' }, (req) => {
      const ids = segsIn(lastUser(req)).map((s) => s.id)
      if (unitOf(req) !== 'chunk-1') return echo(req)
      asked.push(ids)
      const full = asked[0]!
      const half = Math.ceil(full.length / 2)
      if (ids.length === full.length) return asSegs(segsIn(lastUser(req)).slice(1).map((s) => ({ id: s.id, text: s.text }))) // an id is missing: retry, then split
      if (ids[0] === full[half] && !pausedOnce) {
        pausedOnce = true
        void service.pause(id) // the second half is in flight
      }
      return echo(req)
    })
    expect((await service.start(id)).status).toBe('paused')
    const full = asked[0]!
    expect(full).toHaveLength(4)
    const half = Math.ceil(full.length / 2)
    const parked = (await service.store.listChunks(id))[0]!
    expect(parked.state).toBe('pending')
    expect(Object.keys(parked.translation)).toEqual(full.slice(0, half))

    const before = asked.length
    expect((await service.start(id)).status).toBe('done')
    expect(asked.slice(before)).toEqual([full.slice(half)])
    const done = await service.store.readChunk(id, 1)
    expect(Object.keys(done.translation)).toEqual(full)
    expect(Object.values(done.translation).every((v) => v.startsWith('[hr] '))).toBe(true)
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

  it('pauses a project the engine left running when the app closed, and it resumes to done', async () => {
    r = await rig()
    const id = await r.create({ enabled: { glossary: true, proofreader: false, qa: false } })
    const service = r.service
    const stale = await service.getProject(id)
    stale.status = 'glossary' // what a run killed during the glossary leaves on disk
    await service.store.save(stale)

    expect(await service.recoverInterrupted()).toEqual([id])
    expect((await service.getProject(id)).status).toBe('paused')
    expect(await fs.readFile(service.store.file(id, 'log.md'), 'utf8')).toContain('stopped during glossary')
    expect(await service.recoverInterrupted()).toEqual([])

    expect((await service.start(id)).status).toBe('done')
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

  it('moves to the next model after two mismatches, and splits only when every model failed', async () => {
    r = await rig()
    // a third mock model as a shared fallback row, behind the project's own two
    const prov = path.join(r.dir, 'config', 'providers.md')
    const text = (await fs.readFile(prov, 'utf8')).replace(/(- id: mock-reviewer\s+family: mock-other)/, '$1\n      - id: mock-fallback\n        family: mock')
    await fs.writeFile(prov, text, 'utf8')
    await r.service.registry.load()
    r.service.registry.setDefaults({ fallbacks: [MODEL, QA_MODEL, 'mock/mock-fallback'], shared: true, lmLoad: { parallel: 1, context: 8192, ttlMinutes: 30 } })
    r.mock.on({ role: 'translator' }, (req) => {
      const segs = segsIn(lastUser(req))
      const unit = unitOf(req)
      if (unit === 'chunk-2' && req.model.endsWith('mock-translator')) return asSegs(segs.slice(0, -1).map((s) => ({ id: s.id, text: `[hr] ${s.text}` })))
      if (unit === 'chunk-3' && segs.length >= 3) return asSegs(segs.slice(1).map((s) => ({ id: s.id, text: `[hr] ${s.text}` })))
      return echo(req)
    })
    const id = await r.create({ agentModels: { glossary: [MODEL], translator: [MODEL, QA_MODEL], proofreader: [MODEL], qa: [QA_MODEL] } })
    expect((await r.service.start(id)).status).toBe('done')
    const seq = (unit: string) => r!.mock.calls.filter((c) => c.meta?.role === 'translator' && c.meta.unit === unit).map((c) => `${c.model.replace('mock-', '')} ${c.meta!.task}`)
    expect(seq('chunk-2')).toEqual(['translator translate', 'translator retry', 'reviewer translate'])
    expect((await r.service.store.listChunks(id))[1]!.model).toBe(QA_MODEL)
    expect(seq('chunk-3')).toEqual(['translator translate', 'translator retry', 'reviewer translate', 'reviewer retry', 'translator translate', 'translator translate'])
    for (const c of await r.service.store.listChunks(id)) expect(Object.values(c.final).every((x) => x.startsWith('[hr] '))).toBe(true)
    expect(r.mock.calls.filter((c) => c.meta?.role === 'translator' && c.model.endsWith('mock-fallback'))).toEqual([])
    expect(r.events.some((e) => e.type === 'log' && /chunk-2: segment mismatch 2 times on mock\/mock-translator, trying mock\/mock-reviewer/.test(e.message))).toBe(true)
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

    // export refuses while a chunk is failed, and writes nothing
    await expect(r.service.exportWithReport(id)).rejects.toThrow(/^export refused: \d+ block\(s\) would stay in the source language: chunk 3 failed .*retry_chunk.*allowPartial/)
    expect(await fs.readdir(path.dirname(r.service.store.file(id, 'output', 'x'))).catch(() => [])).toEqual([])
    // allowPartial: the failed chunk's blocks keep the source text, with one warning
    const partial = await r.service.exportWithReport(id, undefined, { allowPartial: true })
    const text = await fs.readFile(partial.path, 'utf8')
    const failedText = chunks[2]!.segments[0]!.text
    expect(text).toContain(`\n${failedText}\n`)
    expect(text).toContain('[hr] ')
    expect(partial.warnings).toHaveLength(1)
    expect(partial.warnings[0]).toMatch(/^\d+ block\(s\) stay in the source language: chunk 3 failed/)

    undo()
    const retry = await r.service.retryChunk(id, 3)
    expect(retry.status).toBe('done')
    const after = await r.service.store.readChunk(id, 3)
    expect(after.state).toBe('done')
    expect(after.error).toBeUndefined()
    expect(after.final[after.segments[0]!.id]).toBe(`[hr] ${failedText}`)
    expect((await r.service.exportWithReport(id)).warnings).toEqual([])
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

  it('stores the QA score and model per chunk (the grade of the reviewer, else derived from the issues) and sums them up', async () => {
    r = await rig()
    // a data-folder prompt from before the score existed: the engine asks for it in the user message
    const promptFile = path.join(r.dir, 'prompts', 'qa.md')
    await fs.writeFile(promptFile, (await fs.readFile(promptFile, 'utf8')).replace(/score/gi, 'grade'), 'utf8')
    const asked: boolean[] = []
    const reviews = new Map<string, number>()
    r.mock.on({ role: 'qa' }, (req) => {
      if (req.meta?.task === 'review') reviews.set(unitOf(req)!, (reviews.get(unitOf(req)!) ?? 0) + 1)
      if (unitOf(req) === 'chunk-2' && req.meta?.task === 'review' && reviews.get('chunk-2') === 1) return 'Looks fine to me, no JSON.' // needs the JSON repair round
      if (req.messages.length === 2) asked.push(lastUser(req).includes('## Score')) // the repair round has more messages
      const first = segsIn([...req.messages].reverse().find((m) => m.role === 'user' && m.content.includes('<pair '))!.content, 'pair')[0]!.id
      if (unitOf(req) === 'chunk-1') return '{"score":"7.26","issues":[]}' // a numeric string is fine; rounded to 1 decimal
      return JSON.stringify({ score: null, issues: [{ segId: first, type: 'omission', severity: 'major', comment: 'A clause is missing.' }, { segId: first, type: 'glossary', severity: 'minor', comment: 'Term.' }] })
    })
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true } })
    await r.service.start(id)
    const chunks = await r.service.store.listChunks(id)
    expect(chunks.length).toBeGreaterThan(1)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(Boolean)).toBe(true)
    // score: null is no score, not a bad reply (one review call); a reply that is no JSON gets exactly one repair round and is then used
    expect(Object.fromEntries(reviews)).toEqual(Object.fromEntries(chunks.map((c) => [`chunk-${c.index}`, c.index === 2 ? 2 : 1])))
    expect(chunks[0]!.qa).toMatchObject({ score: 7.3, model: 'mock/mock-reviewer' })
    for (const c of chunks.slice(1)) {
      const majors = c.qa.issues.filter((i) => i.severity === 'major').length
      expect(c.qa.score).toBe(Math.max(0, 10 - 3 * majors - (c.qa.issues.length - majors)))
      expect(c.qa.score).toBeLessThan(10)
    }
    const mean = Math.round((chunks.reduce((n, c) => n + c.qa.score!, 0) / chunks.length) * 10) / 10
    const expected = { score: mean, scored: chunks.length, models: ['mock/mock-reviewer'], independent: true }
    expect(summarize(await r.service.store.load(id), chunks).qa).toEqual(expected)
    expect((await r.service.detail(id)).qa).toEqual(expected)
    expect((await r.service.detail(id)).chunks[0]!.qaScore).toBe(7.3)
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

  it('sends minor issues to the fixer too with fixMinorIssues', async () => {
    r = await rig()
    r.mock.on({ role: 'qa' }, (req) => {
      const user = lastUser(req)
      if (unitOf(req) !== 'chunk-1' || user.includes('[fixed]')) return '{"issues":[]}'
      return JSON.stringify({ issues: [{ segId: segsIn(user, 'pair')[0]!.id, type: 'mistranslation', severity: 'minor', comment: 'Slightly off.' }] })
    })
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true }, fixMinorIssues: true })
    expect((await r.service.start(id)).status).toBe('done')
    expect(r.calls('translator', 'fix').map((c) => c.unit)).toEqual(['chunk-1'])
    const chunk = (await r.service.store.listChunks(id))[0]!
    expect(chunk.final[chunk.segments[0]!.id]).toContain('[fixed]')
    expect(chunk.qa.issues).toEqual([])
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

  it('keeps the QA score of an edited chunk, marked edited', async () => {
    r = await rig()
    r.mock.on({ role: 'qa' }, '{"score":7,"issues":[]}')
    const id = await r.create({ enabled: { glossary: false, proofreader: false, qa: true } })
    await r.service.start(id)
    const before = (await r.service.detail(id)).qa
    const edited = await r.service.editChunk(id, 1, { [(await r.service.store.readChunk(id, 1)).segments[0]!.id]: 'Ručno.' })
    expect(edited.qa).toEqual({ issues: [], score: 7, model: 'mock/mock-reviewer', edited: true })
    expect((await r.service.detail(id)).qa).toEqual(before)
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

describe('parallel translation', () => {
  const oneChapter = () => bookText(1, 10).replace('# Test Book\n\n', '')

  /** Scripts the translator to hold each request for a while and counts the most requests in flight at once. */
  function trackInFlight(rg: Rig) {
    const stat = { now: 0, max: 0, withPrev: 0, calls: 0 }
    rg.mock.on({ role: 'translator' }, async (req) => {
      stat.calls++
      if (lastUser(req).includes('## Previous passage')) stat.withPrev++
      stat.now++
      stat.max = Math.max(stat.max, stat.now)
      await new Promise((res) => setTimeout(res, 40))
      stat.now--
      return echo(req)
    })
    return stat
  }

  it('runs one request at a time with parallel off, even for several sections', async () => {
    r = await rig({ content: bookText(3, 6) })
    const stat = trackInFlight(r)
    const id = await r.create({ parallel: { enabled: false, maxAtOnce: 'auto', splitSections: false } })
    expect((await r.service.start(id)).status).toBe('done')
    expect(stat.calls).toBeGreaterThan(3)
    expect(stat.max).toBe(1)
  })

  it('runs sections at once up to the provider concurrency by default (maxAtOnce auto)', async () => {
    r = await rig({ content: bookText(6, 3) })
    const stat = trackInFlight(r)
    const id = await r.create()
    expect((await r.service.start(id)).status).toBe('done')
    // the mock provider allows 4 at once
    expect(stat.max).toBeGreaterThan(1)
    expect(stat.max).toBeLessThanOrEqual(4)
  })

  it('caps the work at maxAtOnce', async () => {
    r = await rig({ content: bookText(8, 3) })
    const stat = trackInFlight(r)
    const id = await r.create({ parallel: { enabled: true, maxAtOnce: 3, splitSections: false } })
    expect((await r.service.start(id)).status).toBe('done')
    expect(stat.max).toBe(3)
  })

  it('keeps the chunks of one section in order, with the previous passage, when not split', async () => {
    r = await rig({ content: oneChapter() })
    const stat = trackInFlight(r)
    const id = await r.create({ parallel: { enabled: true, maxAtOnce: 'auto', splitSections: false } })
    await r.service.start(id)
    const chunks = await r.service.store.listChunks(id)
    expect(new Set(chunks.map((c) => c.sectionId)).size).toBe(1)
    expect(chunks.length).toBeGreaterThan(2)
    expect(stat.max).toBe(1)
    expect(stat.withPrev).toBe(chunks.length - 1)
  })

  it('runs the chunks of one section at once with splitSections, and sends no previous passage while the earlier chunk is unfinished', async () => {
    r = await rig({ content: oneChapter() })
    const stat = trackInFlight(r)
    const id = await r.create({ parallel: { enabled: true, maxAtOnce: 16, splitSections: true } })
    expect((await r.service.start(id)).status).toBe('done')
    const chunks = await r.service.store.listChunks(id)
    expect(new Set(chunks.map((c) => c.sectionId)).size).toBe(1)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.length).toBeLessThanOrEqual(16)
    expect(chunks.every((c) => c.state === 'done')).toBe(true)
    // the mock provider allows 4 requests at once
    expect(stat.max).toBeGreaterThan(1)
    expect(stat.max).toBeLessThanOrEqual(4)
    // every worker started before any chunk was finished: nobody had a finished previous chunk
    expect(stat.withPrev).toBe(0)
  })

  it('gives a split chunk the previous passage when the earlier chunk is already done (resume)', async () => {
    r = await rig({ content: oneChapter() })
    const id = await r.create({ parallel: { enabled: true, maxAtOnce: 16, splitSections: true } })
    await r.service.start(id)
    // chunks 2.. go back to pending, chunk 1 stays done
    const chunks = await r.service.store.listChunks(id)
    for (const c of chunks.slice(1)) {
      c.state = 'pending'
      c.translation = {}
      c.final = {}
      await r.service.store.writeChunk(id, c)
    }
    const stat = trackInFlight(r)
    // one worker at a time: each chunk finds its predecessor finished
    const project = await r.service.store.load(id)
    project.settings.parallel.maxAtOnce = 1
    await r.service.store.save(project)
    await r.service.start(id)
    expect(stat.calls).toBe(chunks.length - 1)
    expect(stat.withPrev).toBe(chunks.length - 1)
  })

  it('lets an old project.json without parallel run, with today\'s behavior', async () => {
    r = await rig({ content: bookText(4, 3) })
    const stat = trackInFlight(r)
    const id = await r.create()
    const file = path.join(r.dir, 'projects', id, 'project.json')
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as { settings: Record<string, unknown> }
    delete json.settings.parallel
    await fs.writeFile(file, JSON.stringify(json), 'utf8')
    const loaded = await r.service.store.load(id)
    expect(loaded.settings.parallel).toEqual({ enabled: true, maxAtOnce: 'auto', splitSections: false })
    expect((await r.service.start(id)).status).toBe('done')
    expect(stat.max).toBeGreaterThan(1)
  })

  it('estimates the time with the number of workers', async () => {
    r = await rig({ content: bookText(4, 6) })
    const id = await r.create()
    const off = await r.service.analyze(id, { parallel: { enabled: false, maxAtOnce: 'auto', splitSections: false } })
    const three = await r.service.analyze(id, { parallel: { enabled: true, maxAtOnce: 3, splitSections: false } })
    expect(off.perAgent.translator!.seconds).toBeCloseTo(three.perAgent.translator!.seconds * 3, 6)
  })
})
