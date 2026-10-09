import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { Document, Element, Node } from '@xmldom/xmldom'
import type { Block, BlockKind, DocumentIR, FormatAdapter, InlineTag, Section, WriteOptions } from '../../shared/ir'
import { type InlineNode, resolveTranslation } from '../publish/inlineTree'
import { isRtl } from '../publish/lang'
import { stripTags } from './inline'

/**
 * EPUB: blocks come from the spine documents (plus nav and NCX labels and the OPF title). The writer edits the original DOMs
 * in place and copies every other archive entry byte for byte.
 *
 * Block ids: `m.1` (OPF dc:title); `d<i>.<n>` for the i-th document (spine order, then nav, then NCX), `d<i>.t` for its <title>.
 */

const DC = 'http://purl.org/dc/elements/1.1/'
const ELEMENT = 1
const TEXT = 3
const CDATA = 4

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'dt', 'dd', 'td', 'th', 'figcaption', 'caption'])
/** Elements that contain blocks (never inline). */
const CONTAINER_TAGS = new Set([
  ...BLOCK_TAGS,
  'div', 'ul', 'ol', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'section', 'article', 'aside', 'nav', 'header', 'footer',
  'figure', 'main', 'body', 'address', 'details', 'summary', 'fieldset', 'form', 'hgroup', 'hr'
])
/** Not translated, not descended into. */
const SKIP_TAGS = new Set(['script', 'style', 'pre', 'head', 'template'])
/** Inline elements kept as one opaque void tag. */
const OPAQUE_TAGS = new Set(['svg', 'math', 'object', 'audio', 'video', 'canvas', 'script', 'style', 'iframe'])

const tagName = (el: Element) => (el.localName || el.nodeName).toLowerCase()
const isEl = (n: Node): n is Element => n.nodeType === ELEMENT
const isText = (n: Node) => n.nodeType === TEXT || n.nodeType === CDATA

function children(el: Node): Node[] {
  const out: Node[] = []
  for (let c = el.firstChild; c; c = c.nextSibling) out.push(c)
  return out
}

function hasContainerDescendant(el: Element): boolean {
  for (const c of children(el)) {
    if (!isEl(c)) continue
    if (CONTAINER_TAGS.has(tagName(c)) || hasContainerDescendant(c)) return true
  }
  return false
}

function parseXml(text: string, mime: 'application/xhtml+xml' | 'application/xml'): Document | null {
  try {
    return new DOMParser({ onError: () => {} }).parseFromString(text, mime)
  } catch {
    return null
  }
}

function serialize(doc: Document): string {
  return new XMLSerializer().serializeToString(doc)
}

/** A block in a DOM: a run of sibling nodes of `parent` (all its children for a plain block element). */
interface Extracted {
  block: Block
  parent: Node
  nodes: Node[]
  /** Original elements behind the tag numbers, cloned on write. */
  els: Map<number, Element>
}

class Ctx {
  n = 0
  tags: InlineTag[] = []
  els = new Map<number, Element>()
}

function inlineText(nodes: Node[], ctx: Ctx): string {
  let out = ''
  for (const node of nodes) {
    if (isText(node)) out += node.nodeValue ?? ''
    else if (isEl(node)) {
      if (node.firstChild === null || OPAQUE_TAGS.has(tagName(node))) {
        const n = ++ctx.n
        ctx.tags.push({ n, kind: 'void', data: { xml: new XMLSerializer().serializeToString(node) } })
        ctx.els.set(n, node)
        out += `<${n}/>`
      } else {
        const n = ++ctx.n
        const attrs: Record<string, string> = {}
        for (let i = 0; i < node.attributes.length; i++) attrs[node.attributes[i]!.name] = node.attributes[i]!.value
        ctx.tags.push({ n, kind: 'pair', data: { name: node.nodeName, attrs } })
        ctx.els.set(n, node)
        out += `<${n}>${inlineText(children(node), ctx)}</${n}>`
      }
    }
  }
  return out
}

const collapse = (s: string) => s.replace(/[ \t\r\n\f]+/g, ' ').trim()

function kindFor(parent: Node, inNav: boolean): BlockKind {
  if (inNav) return 'toc'
  const name = isEl(parent) ? tagName(parent) : ''
  if (/^h[1-6]$/.test(name)) return 'heading'
  if (name === 'li' || name === 'dt' || name === 'dd') return 'item'
  if (name === 'td' || name === 'th') return 'cell'
  if (name === 'figcaption' || name === 'caption') return 'caption'
  return 'para'
}

/** Extracts the translatable blocks of an XHTML document in document order. */
function extractXhtml(doc: Document, key: string, isNavDoc: boolean): Extracted[] {
  const out: Extracted[] = []
  let count = 0
  const add = (parent: Node, nodes: Node[], inNav: boolean) => {
    const ctx = new Ctx()
    const text = collapse(inlineText(nodes, ctx))
    if (stripTags(text).trim() === '') return
    out.push({ block: { id: `${key}.${++count}`, kind: kindFor(parent, inNav), text, tags: ctx.tags }, parent, nodes, els: ctx.els })
  }
  const walk = (parent: Element, inNav: boolean) => {
    let run: Node[] = []
    const flush = () => {
      if (run.some((n) => isText(n) && (n.nodeValue ?? '').trim() !== '' || isEl(n))) add(parent, run, inNav)
      run = []
    }
    for (const child of children(parent)) {
      if (isEl(child)) {
        const name = tagName(child)
        if (SKIP_TAGS.has(name)) {
          flush()
          continue
        }
        if (CONTAINER_TAGS.has(name)) {
          flush()
          const nav = inNav || name === 'nav'
          if (hasContainerDescendant(child)) walk(child, nav)
          else add(child, children(child), nav)
          continue
        }
        run.push(child)
      } else if (isText(child)) run.push(child)
    }
    flush()
  }
  const body = doc.getElementsByTagName('body')[0]
  if (body) walk(body, isNavDoc)
  return out
}

/** The <title> of an XHTML document as a block (plain text). */
function extractTitle(doc: Document, key: string): Extracted | null {
  const el = doc.getElementsByTagName('title')[0]
  if (!el) return null
  const nodes = children(el)
  const text = collapse(nodes.map((n) => (isText(n) ? (n.nodeValue ?? '') : '')).join(''))
  if (!text) return null
  return { block: { id: `${key}.t`, kind: 'heading', text, tags: [] }, parent: el, nodes, els: new Map() }
}

/** NCX labels (`navLabel/text`, `docTitle/text`). */
function extractNcx(doc: Document, key: string): Extracted[] {
  const out: Extracted[] = []
  let count = 0
  for (const el of Array.from(doc.getElementsByTagName('text'))) {
    const p = el.parentNode
    const pn = p && isEl(p) ? tagName(p) : ''
    if (pn !== 'navlabel' && pn !== 'doctitle') continue
    const nodes = children(el)
    const text = collapse(nodes.map((n) => (isText(n) ? (n.nodeValue ?? '') : '')).join(''))
    if (!text) continue
    out.push({ block: { id: `${key}.${++count}`, kind: 'toc', text, tags: [] }, parent: el, nodes, els: new Map() })
  }
  return out
}

function buildNodes(doc: Document, nodes: InlineNode[], els: Map<number, Element>): Node[] {
  const out: Node[] = []
  for (const n of nodes) {
    if (n.type === 'text') out.push(doc.createTextNode(n.text))
    else if (n.type === 'void') {
      const el = els.get(n.n)
      if (el) out.push(el.cloneNode(true))
    } else {
      const el = els.get(n.n)
      if (!el) {
        out.push(...buildNodes(doc, n.children, els))
        continue
      }
      const copy = el.cloneNode(false)
      for (const c of buildNodes(doc, n.children, els)) copy.appendChild(c)
      out.push(copy)
    }
  }
  return out
}

function applyTranslation(doc: Document, ex: Extracted, translated: string): void {
  const fresh = buildNodes(doc, resolveTranslation(ex.block, translated), ex.els)
  const first = ex.nodes[0]
  for (const n of fresh) {
    if (first && first.parentNode === ex.parent) ex.parent.insertBefore(n, first)
    else ex.parent.appendChild(n)
  }
  for (const n of ex.nodes) if (n.parentNode === ex.parent) ex.parent.removeChild(n)
}

function setDocLanguage(doc: Document, lang: string): void {
  const root = doc.documentElement
  if (!root) return
  if (tagName(root) === 'html') {
    root.setAttribute('lang', lang)
    root.setAttribute('xml:lang', lang)
    if (isRtl(lang)) root.setAttribute('dir', 'rtl')
    else if (root.getAttribute('dir') === 'rtl') root.removeAttribute('dir')
  } else if (tagName(root) === 'ncx') root.setAttribute('xml:lang', lang)
}

interface DocEntry {
  path: string
  kind: 'xhtml' | 'nav' | 'ncx'
}

interface Loaded {
  zip: JSZip
  opfPath: string
  opf: Document
  entries: DocEntry[]
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

async function readText(zip: JSZip, name: string): Promise<string | null> {
  const f = zip.file(name)
  return f ? f.async('string') : null
}

async function loadEpub(file: string): Promise<Loaded> {
  const zip = await JSZip.loadAsync(await fs.readFile(file))
  const container = await readText(zip, 'META-INF/container.xml')
  if (!container) throw new Error('not a valid EPUB: META-INF/container.xml is missing')
  const cdoc = parseXml(container, 'application/xml')
  const rootfile = cdoc?.getElementsByTagName('rootfile')[0]
  const opfPath = rootfile?.getAttribute('full-path')
  if (!opfPath) throw new Error('not a valid EPUB: no rootfile in container.xml')
  const opfText = await readText(zip, opfPath)
  const opf = opfText ? parseXml(opfText, 'application/xml') : null
  if (!opf) throw new Error(`not a valid EPUB: cannot read ${opfPath}`)
  const dir = path.posix.dirname(opfPath)
  const resolve = (href: string) => path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decode(href.split('#')[0]!)))

  const items = new Map<string, { href: string; type: string; props: string[] }>()
  for (const it of Array.from(opf.getElementsByTagName('item'))) {
    items.set(it.getAttribute('id') ?? '', {
      href: it.getAttribute('href') ?? '',
      type: it.getAttribute('media-type') ?? '',
      props: (it.getAttribute('properties') ?? '').split(/\s+/)
    })
  }
  const isHtml = (t: string) => t === 'application/xhtml+xml' || t === 'text/html'
  const navItem = [...items.values()].find((i) => i.props.includes('nav'))
  const navPath = navItem ? resolve(navItem.href) : undefined
  const entries: DocEntry[] = []
  const seen = new Set<string>()
  const addEntry = (p: string, kind: DocEntry['kind']) => {
    if (seen.has(p) || !zip.file(p)) return
    seen.add(p)
    entries.push({ path: p, kind })
  }
  for (const ref of Array.from(opf.getElementsByTagName('itemref'))) {
    const it = items.get(ref.getAttribute('idref') ?? '')
    if (!it || !isHtml(it.type)) continue
    const p = resolve(it.href)
    addEntry(p, p === navPath ? 'nav' : 'xhtml')
  }
  if (navPath) addEntry(navPath, 'nav')
  for (const it of items.values()) if (it.type === 'application/x-dtbncx+xml') addEntry(resolve(it.href), 'ncx')
  return { zip, opfPath, opf, entries }
}

function opfTitleEl(opf: Document): Element | undefined {
  return opf.getElementsByTagNameNS(DC, 'title')[0]
}

function firstHeading(blocks: Block[]): string | undefined {
  const h = blocks.find((b) => b.kind === 'heading')
  return h ? stripTags(h.text) : undefined
}

function parseDoc(text: string, e: DocEntry): Document | null {
  return parseXml(text, e.kind === 'ncx' ? 'application/xml' : 'application/xhtml+xml')
}

async function read(file: string): Promise<DocumentIR> {
  const { zip, opf, entries } = await loadEpub(file)
  const sections: Section[] = []
  const titleEl = opfTitleEl(opf)
  const title = titleEl ? collapse(titleEl.textContent ?? '') : ''
  const lang = collapse(opf.getElementsByTagNameNS(DC, 'language')[0]?.textContent ?? '')
  if (title) sections.push({ id: 's0', blocks: [{ id: 'm.1', kind: 'heading', text: title, tags: [] }] })
  for (const [i, e] of entries.entries()) {
    const text = await readText(zip, e.path)
    const doc = text ? parseDoc(text, e) : null
    if (!doc) continue
    const key = `d${i + 1}`
    const ex = e.kind === 'ncx' ? extractNcx(doc, key) : extractXhtml(doc, key, e.kind === 'nav')
    const t = e.kind === 'ncx' ? null : extractTitle(doc, key)
    const blocks = [...(t ? [t.block] : []), ...ex.map((x) => x.block)]
    if (blocks.length === 0) continue
    sections.push({ id: `s${i + 1}`, title: firstHeading(ex.map((x) => x.block)) ?? t?.block.text, blocks })
  }
  return { format: 'epub', meta: { title: title || undefined, language: lang || undefined }, sections }
}

async function write(_ir: DocumentIR, translations: Map<string, string>, srcPath: string, outPath: string, opts: WriteOptions = {}): Promise<void> {
  const { zip, opfPath, opf, entries } = await loadEpub(srcPath)
  const lang = opts.targetLanguage?.trim() || undefined
  const replaced = new Map<string, string>()

  // OPF: title, language, page direction
  const t = translations.get('m.1')
  const titleEl = opfTitleEl(opf)
  if (t !== undefined && titleEl) titleEl.textContent = stripTags(t).trim()
  if (lang) {
    const langEl = opf.getElementsByTagNameNS(DC, 'language')[0]
    if (langEl) langEl.textContent = lang
    else if (titleEl?.parentNode) {
      const el = opf.createElementNS(DC, 'dc:language')
      el.textContent = lang
      titleEl.parentNode.appendChild(el)
    }
    const pkg = opf.documentElement
    if (pkg && pkg.hasAttribute('xml:lang')) pkg.setAttribute('xml:lang', lang)
    const spine = opf.getElementsByTagName('spine')[0]
    if (spine) {
      if (isRtl(lang)) spine.setAttribute('page-progression-direction', 'rtl')
      else if (spine.getAttribute('page-progression-direction') === 'rtl') spine.removeAttribute('page-progression-direction')
    }
  }
  replaced.set(opfPath, serialize(opf))

  for (const [i, e] of entries.entries()) {
    const text = await readText(zip, e.path)
    const doc = text ? parseDoc(text, e) : null
    if (!doc) continue
    const key = `d${i + 1}`
    const all = [...(e.kind === 'ncx' ? [] : [extractTitle(doc, key)]), ...(e.kind === 'ncx' ? extractNcx(doc, key) : extractXhtml(doc, key, e.kind === 'nav'))]
    for (const ex of all) {
      if (!ex) continue
      const tr = translations.get(ex.block.id)
      if (tr !== undefined) applyTranslation(doc, ex, tr)
    }
    if (lang) setDocLanguage(doc, lang)
    replaced.set(e.path, serialize(doc))
  }

  const out = new JSZip()
  const mimetype = zip.file('mimetype')
  out.file('mimetype', mimetype ? await mimetype.async('uint8array') : 'application/epub+zip', { compression: 'STORE', createFolders: false })
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]!
    if (entry.dir || name === 'mimetype') continue
    const data = replaced.get(name) ?? (await entry.async('uint8array'))
    out.file(name, data, { date: entry.date, createFolders: false, compression: 'DEFLATE' })
  }
  await fs.writeFile(outPath, await out.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' }))
}

export const epubAdapter: FormatAdapter = { outputExt: '.epub', read, write }
