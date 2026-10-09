import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { adapterFor, formatOf } from '../src/engine/formats'
import { writePdfMarkdown } from '../src/engine/formats/pdf'
import type { DocumentIR } from '../src/shared/ir'
import { type PdfLine, makePdf } from './fixtures/builders'
import { tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const L = (text: string, y: number, size = 12, x = 72): PdfLine => ({ text, x, y, size })
const header = (n: number): PdfLine[] => [L('The Great Test Book', 750, 9), L(`Page ${n}`, 30, 9)]

/** Three pages: chapter headings on pages 1 and 3, a hyphenated line, a paragraph that continues over a page break. */
function fixturePages(): PdfLine[][] {
  return [
    [
      ...header(1),
      L('Chapter One', 690, 24),
      L('This is the first paragraph of the book and it is long enough to need', 640),
      L('several lines. It contains a transla-', 626),
      L('tion of something. The paragraph ends here.', 612),
      L('The second paragraph starts after a larger gap and runs over the', 584),
      L('page break without ending its sentence', 570)
    ],
    [
      ...header(2),
      L('so it continues on the next page. Done.', 700),
      L('A third short paragraph.', 672)
    ],
    [...header(3), L('Chapter Two', 690, 24), L('Text of the second chapter goes here.', 640)]
  ]
}

async function setup(pages: PdfLine[][]) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const src = path.join(dir, 'book.pdf')
  await fs.writeFile(src, makePdf(pages))
  return { dir, src }
}

const blocksOf = (ir: DocumentIR) => ir.sections.flatMap((s) => s.blocks)

describe('pdf adapter', () => {
  it('is registered with .epub default output', () => {
    expect(formatOf('a.pdf')).toBe('pdf')
    expect(adapterFor('a.pdf').outputExt).toBe('.epub')
  })

  it('extracts headings and paragraphs, joins hyphenation, drops headers and page numbers', async () => {
    const { src } = await setup(fixturePages())
    const ir = await adapterFor(src).read(src)
    expect(ir.format).toBe('pdf')
    expect(blocksOf(ir).map((b) => [b.kind, b.text])).toEqual([
      ['heading', 'Chapter One'],
      ['para', 'This is the first paragraph of the book and it is long enough to need several lines. It contains a translation of something. The paragraph ends here.'],
      ['para', 'The second paragraph starts after a larger gap and runs over the page break without ending its sentence so it continues on the next page. Done.'],
      ['para', 'A third short paragraph.'],
      ['heading', 'Chapter Two'],
      ['para', 'Text of the second chapter goes here.']
    ])
    expect(blocksOf(ir).filter((b) => b.kind === 'heading').map((b) => b.level)).toEqual([1, 1])
    expect(ir.sections.map((s) => s.title)).toEqual(['Chapter One', 'Chapter Two'])
    expect(ir.meta.title).toBe('Chapter One')
    expect(blocksOf(ir).map((b) => b.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
    expect(await adapterFor(src).read(src)).toEqual(ir)
  })

  it('rejects a PDF without a text layer', async () => {
    const { src } = await setup([[], []])
    await expect(adapterFor(src).read(src)).rejects.toThrow(/scanned PDF.*OCR not supported/)
  })

  it('writes an EPUB with chapters, translated text, language and rtl', async () => {
    const { dir, src } = await setup(fixturePages())
    const adapter = adapterFor(src)
    const ir = await adapter.read(src)
    const tr = new Map(blocksOf(ir).map((b) => [b.id, b.text.toUpperCase()]))
    const out = path.join(dir, 'out.epub')
    await adapter.write(ir, tr, src, out, { targetLanguage: 'ar' })
    const zip = await JSZip.loadAsync(await fs.readFile(out))
    expect(Object.keys(zip.files)[0]).toBe('mimetype')
    const ch1 = await zip.file('OEBPS/chapter-001.xhtml')!.async('string')
    expect(ch1).toContain('<h1>CHAPTER ONE</h1>')
    expect(ch1).toContain('<p>A THIRD SHORT PARAGRAPH.</p>')
    expect(ch1).toContain('lang="ar"')
    expect(ch1).toContain('dir="rtl"')
    expect(await zip.file('OEBPS/chapter-002.xhtml')!.async('string')).toContain('TEXT OF THE SECOND CHAPTER')
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:language>ar</dc:language>')
    expect(opf).toContain('<dc:title>CHAPTER ONE</dc:title>')
    expect(await zip.file('OEBPS/nav.xhtml')!.async('string')).toContain('CHAPTER TWO')
  })

  it('strips stray tags and writes Markdown', async () => {
    const { dir, src } = await setup(fixturePages())
    const adapter = adapterFor(src)
    const ir = await adapter.read(src)
    const tr = new Map([['p1', 'Poglavlje prvo'], ['p4', 'Treći <1>kratki</1> odlomak.']])
    const md = path.join(dir, 'out.md')
    await adapter.write(ir, tr, src, md)
    const text = await fs.readFile(md, 'utf8')
    expect(text.startsWith('# Poglavlje prvo\n\nThis is the first paragraph')).toBe(true)
    expect(text).toContain('\n\nTreći kratki odlomak.\n\n# Chapter Two\n\n')
    const md2 = path.join(dir, 'out2.md')
    await writePdfMarkdown(ir, new Map(), md2)
    expect(await fs.readFile(md2, 'utf8')).toContain('# Chapter One')
  })
})
