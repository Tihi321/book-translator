import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { adapterFor, formatOf } from '../src/engine/formats'
import { stripTags } from '../src/engine/formats/inline'
import type { DocumentIR } from '../src/shared/ir'
import { CSS, PNG, makeEpub } from './fixtures/builders'
import { tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** Uppercases the text outside placeholder tags. */
const upper = (t: string) => t.split(/(<\/?\d+\/?>)/).map((p) => (/^<\/?\d+\/?>$/.test(p) ? p : p.toUpperCase())).join('')

async function setup() {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const src = path.join(dir, 'book.epub')
  await fs.writeFile(src, await makeEpub())
  return { dir, src, out: path.join(dir, 'out.epub') }
}

const blocksOf = (ir: DocumentIR) => ir.sections.flatMap((s) => s.blocks)

async function translate(fn: ((t: string) => string) | null, lang?: string) {
  const { src, out } = await setup()
  const adapter = adapterFor(src)
  const ir = await adapter.read(src)
  const tr = new Map<string, string>()
  if (fn) for (const b of blocksOf(ir)) tr.set(b.id, fn(b.text))
  await adapter.write(ir, tr, src, out, { targetLanguage: lang })
  return { ir, src, out, adapter, zip: await JSZip.loadAsync(await fs.readFile(out)) }
}

describe('epub adapter', () => {
  it('is registered with .epub output', () => {
    expect(formatOf('a.epub')).toBe('epub')
    expect(adapterFor('a.epub').outputExt).toBe('.epub')
  })

  it('reads blocks, kinds, tags and titles in spine order', async () => {
    const { src } = await setup()
    const ir = await adapterFor(src).read(src)
    expect(ir.format).toBe('epub')
    expect(ir.meta).toEqual({ title: 'The Test Book', language: 'en' })
    const b = blocksOf(ir)
    const byText = (s: string) => b.find((x) => x.text.includes(s))!
    expect(b[0]).toMatchObject({ id: 'm.1', kind: 'heading', text: 'The Test Book' })
    expect(byText('brave').text).toBe('Hello <1>brave</1> new <2>world <3>of</3> books</2>, see <4>the next chapter</4>.<5/>Second line & more.')
    expect(byText('brave').tags.map((t) => t.kind)).toEqual(['pair', 'pair', 'pair', 'pair', 'void'])
    // nested li: the text of the li and the nested item are separate blocks, li with a paragraph yields the paragraph
    expect(b.map((x) => x.text)).toEqual(expect.arrayContaining(['Plain item', 'Item with <1>bold</1> start', 'Nested item', 'Item with paragraph', 'Quoted text.']))
    expect(byText('Item with paragraph').kind).toBe('para')
expect(byText('Plain item').kind).toBe('item')
    expect(byText('A div with inline').text).toBe('A div with inline<1> children</1> only.')
    expect(byText('A div with a paragraph.').kind).toBe('para')
    expect(byText('Cell').kind).toBe('cell')
    expect(byText('Cell').text).toBe('Cell <1>1</1>')
    expect(b.some((x) => x.text.includes('do not translate'))).toBe(false)
    // nav and ncx labels are toc blocks, <title> is a heading
    expect(b.filter((x) => x.kind === 'toc').map((x) => x.text)).toEqual(
      expect.arrayContaining(['Contents', '<1>Chapter One</1>', '<1>Chapter Two</1>', 'The Test Book', 'Chapter One', 'Chapter Two'])
    )
    expect(b.find((x) => x.id === 'd1.t')).toMatchObject({ kind: 'heading', text: 'Chapter One' })
    // spine order and section titles; ids are deterministic
    expect(ir.sections.map((s) => s.title)).toEqual([undefined, 'Chapter One', 'Chapter Two', 'Contents', undefined])
    const again = await adapterFor(src).read(src)
    expect(again).toEqual(ir)
  })

  it('identity translation keeps the book equivalent and every other file byte for byte', async () => {
    const { ir, src, zip, adapter, out } = await translate((t) => t)
    const back = await adapter.read(out)
    expect(back).toEqual(ir)
    const orig = await JSZip.loadAsync(await fs.readFile(src))
    expect(Object.keys(zip.files)).toEqual(Object.keys(orig.files))
    expect(Object.keys(zip.files)[0]).toBe('mimetype')
    const raw = await fs.readFile(out)
    expect(raw.subarray(30, 38).toString()).toBe('mimetype')
    expect(raw.readUInt16LE(8)).toBe(0) // first entry is stored, not deflated
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip')
    expect(Buffer.from(await zip.file('OEBPS/images/pic.png')!.async('uint8array'))).toEqual(Buffer.from(PNG))
    expect(await zip.file('OEBPS/style.css')!.async('string')).toBe(CSS)
    // structure survives: same elements in the chapter
    const html = await zip.file('OEBPS/text/ch 1.xhtml')!.async('string')
    expect(html).toContain('<img src="../images/pic.png" alt="pic"/>')
    expect(html).toContain('<a href="ch2.xhtml#x">the next chapter</a>')
    expect(html).toContain('<pre>do not translate</pre>')
    expect(html).toContain('<br/>')
  })

  it('writes translated text with inline tags restored, language and title', async () => {
    const { zip } = await translate(upper, 'hr')
    const html = await zip.file('OEBPS/text/ch 1.xhtml')!.async('string')
    expect(html).toContain('HELLO <em>BRAVE</em> NEW <strong>WORLD <i>OF</i> BOOKS</strong>, SEE <a href="ch2.xhtml#x">THE NEXT CHAPTER</a>.<br/>SECOND LINE &amp; MORE.')
    expect(html).toContain('<h1 id="c1">CHAPTER ONE</h1>')
    expect(html).toContain('<title>CHAPTER ONE</title>')
    expect(html).toContain('lang="hr"')
    expect(html).toContain('xml:lang="hr"')
    expect(html).toContain('<td>CELL <sup>1</sup></td>')
    expect(html).toContain('<li>ITEM WITH <b>BOLD</b> START<ul><li>NESTED ITEM</li></ul></li>')
    const opf = await zip.file('OEBPS/content.opf')!.async('string')
    expect(opf).toContain('<dc:title>THE TEST BOOK</dc:title>')
    expect(opf).toContain('<dc:language>hr</dc:language>')
    expect(await zip.file('OEBPS/toc.ncx')!.async('string')).toContain('<text>CHAPTER TWO</text>')
    expect(await zip.file('OEBPS/nav.xhtml')!.async('string')).toContain('<a href="text/ch%201.xhtml">CHAPTER ONE</a>')
    expect(html).not.toContain('dir="rtl"')
  })

  it('sets dir="rtl" for right-to-left targets', async () => {
    const { zip } = await translate((t) => t, 'ar')
    expect(await zip.file('OEBPS/text/ch2.xhtml')!.async('string')).toContain('dir="rtl"')
    expect(await zip.file('OEBPS/content.opf')!.async('string')).toContain('page-progression-direction="rtl"')
  })

  it('falls back to plain text when the tags do not match', async () => {
    const { ir, src, out, adapter } = await translate(null)
    const id = blocksOf(ir).find((b) => b.text.startsWith('Hello <1>brave'))!.id
    const bad = new Map([[id, 'Zdravo <1>hrabri novi svijet, <9>x</9>']])
    await adapter.write(ir, bad, src, out, { targetLanguage: 'hr' })
    const html = await (await JSZip.loadAsync(await fs.readFile(out))).file('OEBPS/text/ch 1.xhtml')!.async('string')
    expect(html).toContain('<p>Zdravo hrabri novi svijet, x</p>')
    expect(stripTags('<1>a</1>')).toBe('a')
  })

  it('untranslated blocks keep the source', async () => {
    const { ir, src, out, adapter } = await translate(null)
    const id = blocksOf(ir).find((b) => b.text === 'Last paragraph.')!.id
    await adapter.write(ir, new Map([[id, 'Zadnji odlomak.']]), src, out)
    const zip = await JSZip.loadAsync(await fs.readFile(out))
    const ch2 = await zip.file('OEBPS/text/ch2.xhtml')!.async('string')
    expect(ch2).toContain('<p>Second chapter text.</p><p>Zadnji odlomak.</p>')
    expect(ch2).toContain('lang="en"')
  })
})
