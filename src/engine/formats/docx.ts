import { promises as fs } from 'node:fs'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { Document, Element, Node } from '@xmldom/xmldom'
import type { Block, BlockKind, DocumentIR, FormatAdapter, InlineTag, Section, WriteOptions } from '../../shared/ir'
import { type InlineNode, resolveTranslation } from '../publish/inlineTree'
import { stripTags } from './inline'

/**
 * DOCX: every `w:p` with text in document.xml, footnotes, endnotes, headers and footers is a block. Runs with the paragraph's
 * most common formatting are plain text; other formatting runs become pair tags (data: the run properties), run children that are
 * not text (tab, break, drawing, note reference...) become void tags, `w:hyperlink` is a pair tag around its runs.
 *
 * Block ids: `<part>-<n>`, part = `d` (document), `footnotes`, `endnotes`, `header1`, `footer2`...
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const ELEMENT = 1

const isW = (n: Node, name: string): n is Element => n.nodeType === ELEMENT && (n as Element).namespaceURI === W && (n as Element).localName === name
const kids = (el: Node): Node[] => {
  const out: Node[] = []
  for (let c = el.firstChild; c; c = c.nextSibling) out.push(c)
  return out
}
const ser = (n: Node) => new XMLSerializer().serializeToString(n)

function parseXml(text: string): Document | null {
  try {
    return new DOMParser({ onError: () => {} }).parseFromString(text, 'application/xml')
  } catch {
    return null
  }
}

/** `own` on a void: the run properties of a run whose formatting differs from the base (else the surrounding ones apply). */
type TagInfo =
  | { type: 'group'; rPr: Element | null }
  | { type: 'link'; el: Element; base: Element | null }
  | { type: 'void'; node: Element; raw: boolean; own?: { rPr: Element | null } }

/** One piece of a paragraph, in order. `key` is the run formatting; raw items (bookmarks...) have no formatting. */
type Item =
  | { type: 'text'; s: string; rPr: Element | null; key: string }
  | { type: 'void'; node: Element; rPr: Element | null; key: string }
  | { type: 'raw'; node: Element }
  | { type: 'link'; el: Element; items: Item[] }

const SKIP_RUN_CHILDREN = new Set(['rPr', 'lastRenderedPageBreak', 'delText'])
const SKIP_PARA_CHILDREN = new Set(['pPr', 'proofErr', 'del', 'moveFrom', 'moveFromRangeStart', 'moveFromRangeEnd'])
const TRANSPARENT = new Set(['ins', 'smartTag', 'customXml', 'moveTo'])

function rPrKey(rPr: Element | null): string {
  if (!rPr) return ''
  return ser(rPr).replace(/<w:lang\b[^>]*\/>/g, '').replace(/<w:noProof\b[^>]*\/>/g, '')
}

function runItems(run: Element, out: Item[]): void {
  const rPr = kids(run).find((c): c is Element => isW(c, 'rPr')) ?? null
  const key = rPrKey(rPr)
  for (const c of kids(run)) {
    if (c.nodeType !== ELEMENT) continue
    const el = c as Element
    if (SKIP_RUN_CHILDREN.has(el.localName ?? '')) continue
    if (isW(el, 't')) {
      const s = el.textContent ?? ''
      if (s) out.push({ type: 'text', s, rPr, key })
    } else out.push({ type: 'void', node: el, rPr, key })
  }
}

function collectItems(container: Element, out: Item[]): void {
  for (const c of kids(container)) {
    if (c.nodeType !== ELEMENT) continue
    const el = c as Element
    const name = el.namespaceURI === W ? (el.localName ?? '') : ''
    if (name === 'r') runItems(el, out)
    else if (name === 'hyperlink') {
      const items: Item[] = []
      collectItems(el, items)
      out.push({ type: 'link', el, items })
    } else if (name === 'sdt') {
      const content = kids(el).find((k): k is Element => isW(k, 'sdtContent'))
      if (content) collectItems(content, out)
    } else if (TRANSPARENT.has(name)) collectItems(el, out)
    else if (SKIP_PARA_CHILDREN.has(name)) continue
    else out.push({ type: 'raw', node: el })
  }
}

const hasText = (items: Item[]): boolean => items.some((i) => (i.type === 'text' && i.s !== '') || (i.type === 'link' && hasText(i.items)))

/** The most common formatting (by text length); ties go to the first. */
function baseOf(items: Item[]): { key: string; rPr: Element | null } {
  const weight = new Map<string, { w: number; rPr: Element | null }>()
  for (const i of items) {
    if (i.type !== 'text' && i.type !== 'void') continue
    const e = weight.get(i.key) ?? { w: 0, rPr: i.rPr }
    e.w += i.type === 'text' ? i.s.length : 0
    weight.set(i.key, e)
  }
  let best: { key: string; rPr: Element | null } = { key: '', rPr: null }
  let bw = -1
  for (const [key, e] of weight) {
    if (e.w > bw) {
      bw = e.w
      best = { key, rPr: e.rPr }
    }
  }
  return best
}

interface Para {
  block: Block
  p: Element
  head: Element[]
  tail: Element[]
  info: Map<number, TagInfo>
  /** Run properties of the paragraph base formatting. */
  base: Element | null
  styleName: string
}

class Counter {
  n = 0
  tags: InlineTag[] = []
  info = new Map<number, TagInfo>()
}

function emit(items: Item[], base: { key: string; rPr: Element | null }, c: Counter): string {
  let out = ''
  let i = 0
  while (i < items.length) {
    const it = items[i]!
    if (it.type === 'raw') {
      const n = ++c.n
      c.tags.push({ n, kind: 'void', data: { xml: ser(it.node) } })
      c.info.set(n, { type: 'void', node: it.node, raw: true })
      out += `<${n}/>`
      i++
    } else if (it.type === 'link') {
      const n = ++c.n
      const lb = baseOf(it.items)
      c.tags.push({ n, kind: 'pair', data: { hyperlink: ser(it.el.cloneNode(false)), rPr: lb.rPr ? ser(lb.rPr) : null } })
      c.info.set(n, { type: 'link', el: it.el, base: lb.rPr })
      out += `<${n}>${emit(it.items, lb, c)}</${n}>`
      i++
    } else {
      // a run of items with the same formatting (raw items between them stay in the group)
      const group: Item[] = [it]
      let j = i + 1
      while (j < items.length) {
        const nx = items[j]!
        if (nx.type === 'raw') {
          // keep raw items inside the group only if more of the group follows
          let k = j
          while (k < items.length && items[k]!.type === 'raw') k++
          const after = items[k]
          if (after && (after.type === 'text' || after.type === 'void') && after.key === it.key) {
            while (j < k) group.push(items[j++]!)
            continue
          }
          break
        }
        if (nx.type === 'link' || nx.key !== it.key) break
        group.push(nx)
        j++
      }
      let inner = ''
      const voidOnly = group.every((g) => g.type !== 'text')
      const plain = it.key === base.key || voidOnly
      let open = ''
      let close = ''
      if (!plain) {
        const n = ++c.n
        c.tags.push({ n, kind: 'pair', data: { rPr: it.rPr ? ser(it.rPr) : null } })
        c.info.set(n, { type: 'group', rPr: it.rPr })
        open = `<${n}>`
        close = `</${n}>`
      }
      for (const g of group) {
        if (g.type === 'text') inner += g.s
        else if (g.type === 'void') {
          const n = ++c.n
          c.tags.push({ n, kind: 'void', data: { xml: ser(g.node) } })
          c.info.set(n, { type: 'void', node: g.node, raw: false, own: it.key === base.key ? undefined : { rPr: g.rPr } })
          inner += `<${n}/>`
        } else if (g.type === 'raw') {
          const n = ++c.n
          c.tags.push({ n, kind: 'void', data: { xml: ser(g.node) } })
          c.info.set(n, { type: 'void', node: g.node, raw: true })
          inner += `<${n}/>`
        }
      }
      out += open + inner + close
      i = j
    }
  }
  return out
}

interface PartCtx {
  styles: Map<string, string>
  key: string
}

function styleName(p: Element, styles: Map<string, string>): string {
  const pPr = kids(p).find((c): c is Element => isW(c, 'pPr'))
  const ps = pPr ? kids(pPr).find((c): c is Element => isW(c, 'pStyle')) : undefined
  const id = ps?.getAttribute('w:val') ?? ''
  return (styles.get(id) ?? id).toLowerCase()
}

function kindOf(p: Element, name: string): BlockKind {
  if (/^(heading\s*\d|title|subtitle)$/.test(name)) return 'heading'
  if (name === 'caption') return 'caption'
  const pPr = kids(p).find((c): c is Element => isW(c, 'pPr'))
  if ((pPr && kids(pPr).some((c) => isW(c, 'numPr'))) || name === 'list paragraph') return 'item'
  for (let a = p.parentNode; a; a = a.parentNode) if (isW(a, 'tc')) return 'cell'
  return 'para'
}

function inFallback(p: Element): boolean {
  for (let a = p.parentNode; a; a = a.parentNode) if (a.nodeType === ELEMENT && (a as Element).localName === 'Fallback') return true
  return false
}

function extractPart(doc: Document, ctx: PartCtx): Para[] {
  const out: Para[] = []
  let count = 0
  for (const p of Array.from(doc.getElementsByTagNameNS(W, 'p'))) {
    if (inFallback(p)) continue
    const items: Item[] = []
    collectItems(p, items)
    if (!hasText(items)) continue
    // raw items before the first and after the last text stay outside the block
    const isTextual = (i: Item) => i.type !== 'raw'
    const first = items.findIndex(isTextual)
    let last = items.length - 1
    while (last >= 0 && !isTextual(items[last]!)) last--
    const head = items.slice(0, first).map((i) => (i as { node: Element }).node)
    const tail = items.slice(last + 1).map((i) => (i as { node: Element }).node)
    const body = items.slice(first, last + 1)
    const base = baseOf(body)
    const c = new Counter()
    const text = emit(body, base, c)
    const name = styleName(p, ctx.styles)
    out.push({ block: { id: `${ctx.key}-${++count}`, kind: kindOf(p, name), text, tags: c.tags }, p, head, tail, info: c.info, base: base.rPr, styleName: name })
  }
  return out
}

function makeRun(doc: Document, prefix: string, rPr: Element | null, child: Node): Element {
  const r = doc.createElementNS(W, `${prefix}:r`)
  if (rPr) r.appendChild(rPr.cloneNode(true))
  r.appendChild(child)
  return r
}

function build(doc: Document, prefix: string, nodes: InlineNode[], rPr: Element | null, info: Map<number, TagInfo>): Node[] {
  const out: Node[] = []
  for (const n of nodes) {
    if (n.type === 'text') {
      const t = doc.createElementNS(W, `${prefix}:t`)
      t.setAttribute('xml:space', 'preserve')
      t.appendChild(doc.createTextNode(n.text))
      out.push(makeRun(doc, prefix, rPr, t))
    } else if (n.type === 'void') {
      const i = info.get(n.n)
      if (!i || i.type !== 'void') continue
      out.push(i.raw ? i.node.cloneNode(true) : makeRun(doc, prefix, i.own ? i.own.rPr : rPr, i.node.cloneNode(true)))
    } else {
      const i = info.get(n.n)
      if (!i) out.push(...build(doc, prefix, n.children, rPr, info))
      else if (i.type === 'group') out.push(...build(doc, prefix, n.children, i.rPr, info))
      else if (i.type === 'link') {
        const h = i.el.cloneNode(false)
        for (const c of build(doc, prefix, n.children, i.base, info)) h.appendChild(c)
        out.push(h)
      }
    }
  }
  return out
}

function applyTranslation(doc: Document, para: Para, translated: string): void {
  const p = para.p
  const prefix = p.prefix || 'w'
  const nodes = build(doc, prefix, resolveTranslation(para.block, translated), para.base, para.info)
  const pPr = kids(p).find((c) => isW(c, 'pPr'))
  for (const c of kids(p)) if (c !== pPr) p.removeChild(c)
  for (const h of para.head) p.appendChild(h)
  for (const n of nodes) p.appendChild(n)
  for (const t of para.tail) p.appendChild(t)
}

function setLang(doc: Document, lang: string): void {
  for (const el of Array.from(doc.getElementsByTagNameNS(W, 'lang'))) if (el.hasAttribute('w:val')) el.setAttribute('w:val', lang)
}

function partKey(name: string): string {
  const base = name.replace(/^word\//, '').replace(/\.xml$/, '')
  return base === 'document' ? 'd' : base
}

function partOrder(name: string): number {
  if (name === 'word/document.xml') return 0
  if (name === 'word/footnotes.xml') return 1
  if (name === 'word/endnotes.xml') return 2
  return 3
}

function partNames(zip: JSZip): string[] {
  const names = Object.keys(zip.files).filter((n) => /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(n))
  return names.sort((a, b) => partOrder(a) - partOrder(b) || a.localeCompare(b, 'en', { numeric: true }))
}

async function loadStyles(zip: JSZip): Promise<{ names: Map<string, string>; doc: Document | null }> {
  const f = zip.file('word/styles.xml')
  const doc = f ? parseXml(await f.async('string')) : null
  const names = new Map<string, string>()
  if (doc) {
    for (const s of Array.from(doc.getElementsByTagNameNS(W, 'style'))) {
      const nm = kids(s).find((c): c is Element => isW(c, 'name'))
      const id = s.getAttribute('w:styleId')
      if (id && nm) names.set(id, nm.getAttribute('w:val') ?? '')
    }
  }
  return { names, doc }
}

async function read(file: string): Promise<DocumentIR> {
  const zip = await JSZip.loadAsync(await fs.readFile(file))
  if (!zip.file('word/document.xml')) throw new Error('not a valid DOCX: word/document.xml is missing')
  const { names, doc: stylesDoc } = await loadStyles(zip)
  const sections: Section[] = []
  let language: string | undefined
  const miscSections = new Map<string, Section>()
  for (const name of partNames(zip)) {
    const doc = parseXml(await zip.file(name)!.async('string'))
    if (!doc) continue
    language ??= doc.getElementsByTagNameNS(W, 'lang')[0]?.getAttribute('w:val') ?? undefined
    const paras = extractPart(doc, { styles: names, key: partKey(name) })
    if (paras.length === 0) continue
    if (name === 'word/document.xml') {
      let cur: Section | null = null
      for (const para of paras) {
        const h1 = para.styleName === 'heading 1'
        if (h1 || !cur) {
          cur = { id: `s${sections.length + 1}`, title: h1 ? stripTags(para.block.text).trim() : undefined, blocks: [] }
          sections.push(cur)
        }
        cur.blocks.push(para.block)
      }
    } else {
      const group = /^word\/(header|footer)/.test(name) ? 'headers' : partKey(name)
      let s = miscSections.get(group)
      if (!s) {
        s = { id: `x-${group}`, title: group === 'headers' ? 'Headers and footers' : group === 'footnotes' ? 'Footnotes' : 'Endnotes', blocks: [] }
        miscSections.set(group, s)
      }
      s.blocks.push(...paras.map((p) => p.block))
    }
  }
  sections.push(...miscSections.values())
  language ??= stylesDoc?.getElementsByTagNameNS(W, 'lang')[0]?.getAttribute('w:val') ?? undefined
  let title: string | undefined
  const core = zip.file('docProps/core.xml')
  if (core) {
    const cdoc = parseXml(await core.async('string'))
    title = cdoc?.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent?.trim() || undefined
  }
  title ??= sections.find((s) => s.title)?.title
  return { format: 'docx', meta: { title, language }, sections }
}

async function write(_ir: DocumentIR, translations: Map<string, string>, srcPath: string, outPath: string, opts: WriteOptions = {}): Promise<void> {
  const zip = await JSZip.loadAsync(await fs.readFile(srcPath))
  const lang = opts.targetLanguage?.trim() || undefined
  const { names, doc: stylesDoc } = await loadStyles(zip)
  const replaced = new Map<string, string>()
  for (const name of partNames(zip)) {
    const doc = parseXml(await zip.file(name)!.async('string'))
    if (!doc) continue
    const paras = extractPart(doc, { styles: names, key: partKey(name) })
    // inner paragraphs first (text boxes inside a paragraph): the outer paragraph clones their already translated subtree
    for (const para of paras.slice().reverse()) {
      const tr = translations.get(para.block.id)
      if (tr !== undefined) applyTranslation(doc, para, tr)
    }
    if (lang) setLang(doc, lang)
    replaced.set(name, ser(doc))
  }
  if (lang && stylesDoc) {
    setLang(stylesDoc, lang)
    replaced.set('word/styles.xml', ser(stylesDoc))
  }
  const out = new JSZip()
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]!
    if (entry.dir) continue
    const data = replaced.get(name) ?? (await entry.async('uint8array'))
    out.file(name, data, { date: entry.date, createFolders: false, compression: 'DEFLATE' })
  }
  await fs.writeFile(outPath, await out.generateAsync({ type: 'nodebuffer' }))
}

export const docxAdapter: FormatAdapter = { outputExt: '.docx', read, write }
