import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { adapterFor, formatOf } from '../src/engine/formats'
import type { DocumentIR } from '../src/shared/ir'
import { makeDocx } from './fixtures/builders'
import { tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const upper = (t: string) => t.split(/(<\/?\d+\/?>)/).map((p) => (/^<\/?\d+\/?>$/.test(p) ? p : p.toUpperCase())).join('')
const blocksOf = (ir: DocumentIR) => ir.sections.flatMap((s) => s.blocks)

async function setup() {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const src = path.join(dir, 'doc.docx')
  await fs.writeFile(src, await makeDocx())
  return { src, out: path.join(dir, 'out.docx') }
}

async function translate(fn: ((t: string) => string) | null, lang?: string) {
  const { src, out } = await setup()
  const adapter = adapterFor(src)
  const ir = await adapter.read(src)
  const tr = new Map<string, string>()
  if (fn) for (const b of blocksOf(ir)) tr.set(b.id, fn(b.text))
  await adapter.write(ir, tr, src, out, { targetLanguage: lang })
  return { ir, src, out, adapter, zip: await JSZip.loadAsync(await fs.readFile(out)) }
}

const textOf = (xml: string) => [...xml.matchAll(/<w:t[ >][^>]*>?([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')

describe('docx adapter', () => {
  it('is registered with .docx output', () => {
    expect(formatOf('a.docx')).toBe('docx')
    expect(adapterFor('a.docx').outputExt).toBe('.docx')
  })

  it('reads paragraphs as blocks with formatting runs as tags', async () => {
    const { src } = await setup()
    const ir = await adapterFor(src).read(src)
    expect(ir.format).toBe('docx')
    expect(ir.meta).toEqual({ title: 'Docx Title', language: 'en-US' })
    expect(ir.sections.map((s) => s.title)).toEqual(['Chapter One', 'Chapter Two', 'Footnotes', 'Headers and footers'])
    const b = blocksOf(ir)
    expect(b.map((x) => x.id)).toEqual(['d-1', 'd-2', 'd-3', 'd-4', 'd-5', 'footnotes-1', 'header1-1'])
    expect(b[0]).toMatchObject({ kind: 'heading', text: 'Chapter One', tags: [] }) // the bookmarks stay outside the block
    const mixed = b[1]!
    expect(mixed.text).toBe('Hello <1>bold</1> world and <2>more bold</2><3/>after tab, <4>a link</4> end<5/>')
    expect(mixed.tags.map((t) => t.kind)).toEqual(['pair', 'pair', 'void', 'pair', 'void'])
    expect(b[2]!.text).toBe('<1>Italic start</1> then plain text that is much longer than the start')
    expect(b[4]).toMatchObject({ kind: 'cell', text: 'Cell text' })
    expect(b[5]!.text).toBe('<1/> The footnote text.')
    expect(b[6]!.text).toBe('Running header')
    expect(await adapterFor(src).read(src)).toEqual(ir)
  })

  it('identity translation reproduces the document', async () => {
    const { ir, zip, adapter, out, src } = await translate((t) => t)
    expect(await adapter.read(out)).toEqual(ir)
    const orig = await JSZip.loadAsync(await fs.readFile(src))
    expect(Object.keys(zip.files)).toEqual(Object.keys(orig.files))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(textOf(doc)).toBe(textOf(await orig.file('word/document.xml')!.async('string')))
    // formatting, hyperlink, tab, bookmark, footnote reference, paragraph properties survive
    expect(doc).toContain('<w:b/>')
    expect(doc).toContain('<w:hyperlink r:id="rId5">')
    expect(doc).toContain('<w:tab/>')
    expect(doc).toContain('<w:bookmarkStart w:id="1" w:name="_Toc1"/>')
    expect(doc).toContain('<w:footnoteReference w:id="2"/>')
    expect(doc).toContain('<w:jc w:val="both"/>')
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>')
    expect(doc).toContain('<w:rStyle w:val="Hyperlink"/>')
    expect(doc).toContain('<w:i/>')
  })

  it('writes translations with formatting runs restored and language set', async () => {
    const { zip } = await translate(upper, 'hr')
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('HELLO ')
    // "BOLD" and "MORE BOLD" are still bold runs, "A LINK" is still inside the hyperlink
    expect(doc).toMatch(/<w:r><w:rPr><w:b\/><w:lang w:val="hr"\/><\/w:rPr><w:t xml:space="preserve">BOLD<\/w:t><\/w:r>/)
    expect(doc).toMatch(/<w:r><w:rPr><w:b\/><w:lang w:val="hr"\/><\/w:rPr><w:t xml:space="preserve">MORE BOLD<\/w:t><\/w:r>/)
    expect(doc).toMatch(/<w:hyperlink r:id="rId5"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/>[^]*?A LINK<\/w:t><\/w:r><\/w:hyperlink>/)
    expect(doc).not.toContain('w:val="en-US"')
    expect(textOf(doc)).toContain('CELL TEXT')
    expect(await zip.file('word/footnotes.xml')!.async('string')).toContain('THE FOOTNOTE TEXT.')
    expect(await zip.file('word/header1.xml')!.async('string')).toContain('RUNNING HEADER')
    expect(await zip.file('word/styles.xml')!.async('string')).toContain('w:val="hr"')
  })

  it('falls back to plain text when the tags do not match', async () => {
    const { ir, src, out, adapter } = await translate(null)
    const bad = new Map([['d-2', 'Zdravo <1>podebljano svijet <7>x</7>']])
    await adapter.write(ir, bad, src, out, { targetLanguage: 'hr' })
    const doc = await (await JSZip.loadAsync(await fs.readFile(out))).file('word/document.xml')!.async('string')
    expect(textOf(doc)).toContain('Zdravo podebljano svijet x')
    expect(doc).not.toContain('<w:tab/>')
  })
})
