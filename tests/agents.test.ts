import { describe, expect, it } from 'vitest'
import { ChunkFailure } from '../src/engine/pipeline/env'
import type { AgentEnv, CallFn } from '../src/engine/pipeline/env'
import { proofreadChunk } from '../src/engine/pipeline/proofreader'
import { deterministicChecks } from '../src/engine/pipeline/qa'
import { prevTail, translateChunk } from '../src/engine/pipeline/translator'
import type { SegmentRec } from '../src/shared/project'
import { SEED_DIR } from './helpers'
import { segsIn, asSegs } from './pipelineHelpers'

const seg = (id: string, text: string): SegmentRec => ({ id, blockId: id, text })

function envWith(reply: (user: string, n: number, task?: string) => string, logs: string[] = []): { env: AgentEnv; users: string[]; tasks: (string | undefined)[] } {
  const users: string[] = []
  const tasks: (string | undefined)[] = []
  const call: CallFn = async (_agent, req) => {
    const user = req.messages[req.messages.length - 1]!.content
    users.push(user)
    tasks.push(req.task)
    return { text: reply(user, users.length, req.task), costUsd: 0, model: 'mock/m', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, ms: 1 }
  }
  return {
    env: { dataDir: SEED_DIR, sourceLanguage: 'English', targetLanguage: 'Croatian', brief: 'a brief', glossary: [{ source: 'Alice', target: 'Alisa', type: 'person' }], call, log: (_l, m) => logs.push(m) },
    users,
    tasks
  }
}

describe('translator', () => {
  it('sends glossary entries that occur, the previous tail and the segments', async () => {
    const { env, users } = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: `T ${s.text}` }))))
    await translateChunk(env, [seg('b2', 'Alice smiled.')], { unit: 'chunk-2', prev: { source: 'Before.', translation: 'Prije.' } })
    expect(users[0]).toContain('Alice => Alisa')
    expect(users[0]).toContain('Prije.')
    expect(users[0]).toContain('<seg id="b2">Alice smiled.</seg>')
    const none = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: s.text }))))
    await translateChunk(none.env, [seg('b1', 'Nothing here.')], { unit: 'c' })
    expect(none.users[0]).not.toContain('Glossary')
  })

  it('retries tag mismatches once, then keeps plain text and records a tags issue', async () => {
    // first reply drops the tags, the retry still does
    const { env, tasks } = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: s.text.replace(/<\/?\d+\/?>/g, '') }))))
    const r = await translateChunk(env, [seg('b1', 'Hello <1>big</1> world'), seg('b2', 'Plain')], { unit: 'c' })
    expect(tasks).toEqual(['translate', 'retry-tags'])
    expect(r.translation.b1).toBe('Hello big world')
    expect(r.translation.b2).toBe('Plain')
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]).toMatchObject({ segId: 'b1', type: 'tags' })
  })

  it('accepts the retry when it fixes the tags', async () => {
    const { env, tasks } = envWith((u, n) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: n === 1 ? 'Bok svijete' : s.text }))))
    const r = await translateChunk(env, [seg('b1', 'Hello <1>world</1>')], { unit: 'c' })
    expect(tasks).toEqual(['translate', 'retry-tags'])
    expect(r.translation.b1).toBe('Hello <1>world</1>')
    expect(r.issues).toEqual([])
  })

  it('retries with a note, splits, then fails', async () => {
    const logs: string[] = []
    const { env, tasks, users } = envWith(() => 'no segments at all', logs)
    const out: Record<string, string> = {}
    await expect(translateChunk(env, [seg('a', 'One'), seg('b', 'Two')], { unit: 'c' }, out)).rejects.toBeInstanceOf(ChunkFailure)
    // full chunk twice, then the first half twice (which fails the chunk)
    expect(tasks).toEqual(['translate', 'retry', 'translate', 'retry'])
    expect(users[1]).toContain('Problem with your previous answer')
    expect(logs.some((l) => /splitting/.test(l))).toBe(true)
  })

  it('keeps the first half when the second half fails', async () => {
    const { env } = envWith((u) => {
      const segs = segsIn(u)
      return segs.length === 2 || segs[0]!.id === 'b' ? 'garbage' : asSegs(segs.map((s) => ({ id: s.id, text: `T ${s.text}` })))
    })
    const out: Record<string, string> = {}
    await expect(translateChunk(env, [seg('a', 'One'), seg('b', 'Two')], { unit: 'c' }, out)).rejects.toThrow(/did not return/)
    expect(out).toEqual({ a: 'T One' })
  })

  it('keeps the indentation of the source', async () => {
    const { env } = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: `Prijevod` }))))
    const r = await translateChunk(env, [seg('b1', '  - item')], { unit: 'c' })
    expect(r.translation.b1).toBe('  Prijevod')
  })

  it('takes the tail of the previous chunk', () => {
    const segs = [seg('b1', 'One'), seg('b2', 'Two'), seg('b3', 'Three')]
    const tail = prevTail(segs, { b1: 'Jedan', b2: 'Dva', b3: 'Tri' })!
    expect(tail.source).toBe('Two\n\nThree')
    expect(tail.translation).toBe('Dva\n\nTri')
    expect(prevTail(segs, {})).toBeUndefined()
  })
})

describe('proofreader', () => {
  const segs = [seg('b1', 'The cat sat on the mat.'), seg('b2', 'It was <1>raining</1>.')]
  const tr = { b1: 'Mačka je sjedila na otiraču.', b2: 'Padala je <1>kiša</1>.' }

  it('uses the proofread text', async () => {
    const { env } = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: s.text + '!' }))))
    const r = await proofreadChunk(env, segs, tr, { unit: 'c' })
    expect(r.proofread.b1).toBe('Mačka je sjedila na otiraču.!')
    expect(r.changed).toBe(2)
  })

  it('keeps the translation when the reply is unusable', async () => {
    const logs: string[] = []
    const { env } = envWith(() => 'sorry', logs)
    const r = await proofreadChunk(env, segs, tr, { unit: 'c' })
    expect(r.proofread).toEqual(tr)
    expect(r.changed).toBe(0)
  })

  it('keeps the translation for a segment that lost its tags or changed size', async () => {
    const { env } = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: s.id === 'b2' ? 'Padala je kiša.' : 'Ok.' }))))
    const r = await proofreadChunk(env, segs, tr, { unit: 'c' })
    expect(r.proofread).toEqual(tr)
  })

  it('sends the source and the translation, separately tagged', async () => {
    const { env, users } = envWith((u) => asSegs(segsIn(u).map((s) => ({ id: s.id, text: s.text }))))
    await proofreadChunk(env, segs, tr, { unit: 'c' })
    expect(users[0]).toContain('<src id="b1">The cat sat on the mat.</src>')
    expect(users[0]).toContain('<seg id="b1">Mačka je sjedila na otiraču.</seg>')
  })
})

describe('deterministic QA checks', () => {
  const gl = [{ source: 'Alice', target: 'Alisa', type: 'person' }]
  const kinds = (segs: SegmentRec[], final: Record<string, string>) => deterministicChecks(segs, final, gl).map((i) => `${i.segId}:${i.type}:${i.severity}`)

  it('flags untranslated text, but not short names or the same language', () => {
    expect(kinds([seg('a', 'This is entirely untranslated text.')], { a: 'This is entirely untranslated text.' })).toContain('a:untranslated:major')
    expect(kinds([seg('a', 'Harry Potter')], { a: 'Harry Potter' })).toEqual([])
    expect(deterministicChecks([seg('a', 'This is entirely untranslated text.')], { a: 'This is entirely untranslated text.' }, [], { sameLanguage: true })).toEqual([])
  })

  it('flags length outliers', () => {
    const src = 'A fairly long sentence that should have a fairly long translation as well.'
    expect(kinds([seg('a', src)], { a: 'Kratko.' })).toEqual(['a:omission:major'])
    expect(kinds([seg('a', src)], { a: src.repeat(4).replace(/long/g, 'duga') })).toEqual(['a:addition:minor'])
    expect(kinds([seg('a', src)], { a: 'Prilično duga rečenica koja bi trebala imati prilično dug prijevod.' })).toEqual([])
  })

  it('flags a missing glossary term as minor', () => {
    expect(kinds([seg('a', 'Alice walked home through the park.')], { a: 'Ana je šetala kući kroz park.' })).toEqual(['a:glossary:minor'])
    expect(kinds([seg('a', 'Alice walked home through the park.')], { a: 'Alisa je šetala kući kroz park.' })).toEqual([])
  })

  it('flags tag mismatches as major', () => {
    expect(kinds([seg('a', 'Say <1>hello</1> to everyone now.')], { a: 'Pozdravi sve od srca danas.' })).toEqual(['a:tags:major'])
  })

  it('skips segments without a translation', () => {
    expect(kinds([seg('a', 'Whatever text this is, long enough.')], {})).toEqual([])
  })
})
