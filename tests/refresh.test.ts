import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { asSegs, bookText, lastUser, rig, segsIn } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

let r: Rig | undefined
afterEach(async () => {
  await r?.cleanup()
  r = undefined
})

const para = (p: number, c: number) => `Paragraph ${p} of chapter ${c}: Alice met Bob in the garden near the old oak tree.`

describe('refresh_source', () => {
  it('keeps unchanged blocks and a hand edit, translates only changed and new ones, drops removed ones; export refuses a changed source', async () => {
    r = await rig()
    const id = await r.create({ parallel: { enabled: false, maxAtOnce: 1, splitSections: false } })
    const service = r.service
    expect((await service.start(id)).status).toBe('done')
    const before = await service.store.listChunks(id)
    const oldBlocks = new Set(before.flatMap((c) => c.segments.map((s) => s.blockId))).size
    const edited = before[0]!.segments[0]!
    await service.editChunk(id, 1, { [edited.id]: 'HAND EDIT' })
    const oldHash = (await service.getProject(id)).sourceHash

    const changed = 'Paragraph 5 of chapter 1 was rewritten.'
    const added = 'A new paragraph in chapter 2.'
    await fs.writeFile(r.file, bookText().replace(`${para(3, 1)}\n\n`, '').replace(para(5, 1), changed).replace(`${para(8, 2)}\n\n`, `${para(8, 2)}\n\n${added}\n\n`), 'utf8')

    await expect(service.exportWithReport(id, undefined, { allowPartial: true })).rejects.toThrow(/^export refused: the source changed:.*refresh_source/)

    const res = await service.refreshSource(id)
    expect(res).toMatchObject({ unchanged: false, blocks: { toTranslate: 2, removed: 2, kept: oldBlocks - 2 }, editedKept: 1 })
    expect(res.chunks.toTranslate).toBeGreaterThanOrEqual(1)
    const project = await service.getProject(id)
    expect(project.sourceHash).not.toBe(oldHash)
    expect((await fs.readdir(service.store.file(id, 'refresh-backup', res.backupRel!.split('/').pop()!))).sort()).toEqual(['chunks', 'project.json', 'source.json'])

    const after = await service.store.listChunks(id)
    expect(after.map((c) => c.index)).toEqual(after.map((_, i) => i + 1))
    const handEdited = after.find((c) => Object.values(c.final).includes('HAND EDIT'))!
    expect(handEdited).toMatchObject({ edited: true, state: 'done' })
    const pending = after.filter((c) => c.state === 'pending')
    expect(pending.flatMap((c) => c.segments.map((s) => s.text)).sort()).toEqual([added, changed].sort())
    const ir = await service.store.readIr(id)
    const blocks = ir.sections.flatMap((s) => s.blocks).filter((b) => b.kind !== 'meta' && b.text.trim() !== '')
    expect(after.flatMap((c) => c.segments.map((s) => s.blockId))).toEqual(blocks.map((b) => b.id))

    const asked: string[][] = []
    r.mock.on({ role: 'translator' }, (req) => {
      const segs = segsIn(lastUser(req))
      asked.push(segs.map((s) => s.text))
      return asSegs(segs.map((s) => ({ id: s.id, text: `[hr] ${s.text}` })))
    })
    expect((await service.start(id)).status).toBe('done')
    expect(asked.length).toBe(pending.length)
    expect(asked.flat().sort()).toEqual([added, changed].sort())

    const out = await fs.readFile(await service.export(id), 'utf8')
    expect(out).toContain('HAND EDIT')
    expect(out).toContain(`[hr] ${changed}`)
    expect(out).toContain(`[hr] ${added}`)
    expect(out).not.toContain('Paragraph 3 of chapter 1')
    expect(out).not.toContain('Paragraph 5 of chapter 1:')

    expect((await service.refreshSource(id)).unchanged).toBe(true)
  })
})
