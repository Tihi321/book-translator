import { promises as fs } from 'node:fs'
import type { Block, DocumentIR, FormatAdapter, Section, WriteOptions } from '../../shared/ir'
import { buildEpub } from '../publish/epub'
import type { EpubChapter } from '../publish/epub'
import { writeMarkdown } from '../publish/markdown'
import { stripTags } from './inline'

/**
 * PDF: text extraction with pdfjs (legacy build, no worker). Lines are built from text items by y position, paragraphs from line
 * gaps and indents, hyphenated line ends are joined, repeated header/footer lines and page numbers are dropped, headings are
 * lines set in a larger font. Layout is not preserved: the output is a new EPUB (default) or Markdown.
 *
 * Block ids: `p<n>` in reading order.
 */

interface TextItem {
  str: string
  x: number
  y: number
  w: number
  size: number
}

interface Line {
  page: number
  pageH: number
  y: number
  x: number
  xEnd: number
  size: number
  text: string
  /** Set when the line is in the top or bottom margin of its page. */
  margin: boolean
}

const TERMINAL = /[.!?:;…"'”’»)\]]$/
const PAGE_NUMBER = /^[-–—\s]*(\d{1,5}|[ivxlcdm]{1,7}|page\s+\d+(\s+(of|\/)\s+\d+)?|\d+\s*(\/|of)\s*\d+)[-–—\s]*$/i

const round = (n: number, step = 0.5) => Math.round(n / step) * step

async function extractLines(data: Uint8Array): Promise<{ lines: Line[]; pages: number; chars: number; title?: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data, useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const lines: Line[] = []
  let chars = 0
  try {
    for (let pn = 1; pn <= doc.numPages; pn++) {
      const page = await doc.getPage(pn)
      const pageH = page.getViewport({ scale: 1 }).height
      const content = await page.getTextContent()
      const items: TextItem[] = []
      for (const it of content.items) {
        if (!('str' in it) || !it.str || it.str.trim() === '') continue
        const [a, b, , , x, y] = it.transform as number[]
        const size = Math.hypot(a ?? 0, b ?? 0) || it.height || 10
        items.push({ str: it.str, x: x ?? 0, y: y ?? 0, w: it.width, size })
        chars += it.str.replace(/\s/g, '').length
      }
      items.sort((p, q) => q.y - p.y || p.x - q.x)
      const groups: TextItem[][] = []
      for (const it of items) {
        const g = groups[groups.length - 1]
        if (g && Math.abs(g[0]!.y - it.y) <= 0.4 * Math.max(g[0]!.size, it.size)) g.push(it)
        else groups.push([it])
      }
      for (const g of groups) {
        g.sort((p, q) => p.x - q.x)
        let text = ''
        let prevEnd = 0
        const sizeChars = new Map<number, number>()
        for (const it of g) {
          const gap = it.x - prevEnd
          if (text && gap > 0.15 * it.size && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' '
          text += it.str
          prevEnd = it.x + it.w
          const k = round(it.size)
          sizeChars.set(k, (sizeChars.get(k) ?? 0) + it.str.length)
        }
        text = text.replace(/\s+/g, ' ').trim()
        if (!text) continue
        const size = [...sizeChars.entries()].sort((p, q) => q[1] - p[1])[0]![0]
        const y = g[0]!.y
        lines.push({ page: pn, pageH, y, x: g[0]!.x, xEnd: prevEnd, size, text, margin: y > pageH * 0.9 || y < pageH * 0.1 })
      }
    }
    let title: string | undefined
    try {
      const meta = await doc.getMetadata()
      const t = (meta.info as { Title?: unknown } | undefined)?.Title
      if (typeof t === 'string' && t.trim()) title = t.trim()
    } catch {
      // metadata is optional
    }
    return { lines, pages: doc.numPages, chars, title }
  } finally {
    await doc.destroy()
  }
}

const normalizeRepeat = (t: string) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()

/** Drops page numbers and header/footer lines that repeat on many pages. */
function dropRunningLines(lines: Line[], pages: number): Line[] {
  const seen = new Map<string, Set<number>>()
  for (const l of lines) {
    if (!l.margin) continue
    const k = normalizeRepeat(l.text)
    const s = seen.get(k) ?? new Set<number>()
    s.add(l.page)
    seen.set(k, s)
  }
  const need = Math.max(2, Math.ceil(pages * 0.5))
  return lines.filter((l) => {
    if (!l.margin) return true
    if (PAGE_NUMBER.test(l.text)) return false
    return (seen.get(normalizeRepeat(l.text))?.size ?? 0) < need
  })
}

function mode(values: number[], weights?: number[]): number {
  const m = new Map<number, number>()
  values.forEach((v, i) => m.set(v, (m.get(v) ?? 0) + (weights?.[i] ?? 1)))
  let best = values[0] ?? 0
  let bw = -1
  for (const [v, w] of m) {
    if (w > bw) {
      best = v
      bw = w
    }
  }
  return best
}

const median = (v: number[]) => (v.length ? v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)]! : 0)

function joinLines(prev: string, next: string): string {
  if (/\p{L}-$/u.test(prev) && /^\p{Ll}/u.test(next)) return prev.slice(0, -1) + next
  return prev + ' ' + next
}

interface Para {
  text: string
  level?: number
}

function buildParagraphs(lines: Line[]): Para[] {
  if (lines.length === 0) return []
  const body = lines.filter((l) => l.text.length > 0)
  const bodySize = mode(body.map((l) => l.size), body.map((l) => l.text.length))
  const isHeading = (l: Line) => l.size >= bodySize * 1.15 && l.text.length <= 200
  const text = body.filter((l) => !isHeading(l))
  const left = mode(text.map((l) => round(l.x, 2)))
  const right = Math.max(...text.map((l) => l.xEnd), left)
  const gaps: number[] = []
  for (let i = 1; i < body.length; i++) {
    const a = body[i - 1]!
    const b = body[i]!
    if (a.page === b.page && !isHeading(a) && !isHeading(b) && a.y - b.y > 0) gaps.push(a.y - b.y)
  }
  const typical = median(gaps) || bodySize * 1.3
  const headSizes = [...new Set(body.filter(isHeading).map((l) => l.size))].sort((a, b) => b - a)
  const levelOf = (size: number) => Math.min(6, headSizes.indexOf(size) + 1)

  const out: Para[] = []
  let cur: Para | null = null
  let prev: Line | null = null
  for (const l of body) {
    const head = isHeading(l)
    let brk = true
    if (cur && prev) {
      const prevHead = isHeading(prev)
      if (head || prevHead) brk = !(head && prevHead && prev.size === l.size && prev.page === l.page && prev.y - l.y < typical * 1.5)
      else {
        const indent = l.x - left > 0.8 * l.size && prev.x - left <= 0.3 * l.size
        const short = prev.xEnd < right - 3 * l.size && TERMINAL.test(prev.text)
        if (prev.page === l.page) brk = prev.y - l.y > typical * 1.45 || indent || short
        else brk = TERMINAL.test(prev.text) && (indent || short)
      }
    }
    if (brk || !cur) {
      cur = { text: l.text, level: head ? levelOf(l.size) : undefined }
      out.push(cur)
    } else cur.text = joinLines(cur.text, l.text)
    prev = l
  }
  return out
}

function paragraphsToIR(paras: Para[], title?: string): DocumentIR {
  const levels = new Map<number, number>()
  for (const p of paras) if (p.level) levels.set(p.level, (levels.get(p.level) ?? 0) + 1)
  // chapters start at the highest heading level that occurs at least twice
  const splitLevel = [...levels.keys()].sort((a, b) => a - b).find((l) => levels.get(l)! >= 2)
  const sections: Section[] = []
  let cur: Section | null = null
  paras.forEach((p, i) => {
    const block: Block = { id: `p${i + 1}`, kind: p.level ? 'heading' : 'para', text: p.text, tags: [] }
    if (p.level) block.level = p.level
    if (!cur || (splitLevel !== undefined && p.level !== undefined && p.level <= splitLevel)) {
      cur = { id: `s${sections.length + 1}`, title: p.level ? p.text : undefined, blocks: [] }
      sections.push(cur)
    }
    cur.blocks.push(block)
  })
  const firstHeading = paras.find((p) => p.level === 1)?.text
  return { format: 'pdf', meta: { title: title ?? firstHeading }, sections }
}

async function read(file: string): Promise<DocumentIR> {
  const buf = await fs.readFile(file)
  const { lines, pages, chars, title } = await extractLines(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  if (chars < 20 || chars < pages * 5) {
    throw new Error('This looks like a scanned PDF (no text layer found): OCR not supported. Run it through an OCR tool first.')
  }
  return paragraphsToIR(buildParagraphs(dropRunningLines(lines, pages)), title)
}

const plain = (ir: DocumentIR, tr: Map<string, string>, b: Block) => stripTags(tr.get(b.id) ?? b.text).trim()

async function write(ir: DocumentIR, translations: Map<string, string>, _srcPath: string, outPath: string, opts: WriteOptions = {}): Promise<void> {
  if (/\.(md|markdown)$/i.test(outPath)) return writeMarkdown(ir, translations, outPath)
  const all = ir.sections.flatMap((s) => s.blocks)
  const srcTitle = ir.meta.title
  const titleBlock = srcTitle ? all.find((b) => b.kind === 'heading' && b.text === srcTitle) : undefined
  const title = (titleBlock ? plain(ir, translations, titleBlock) : srcTitle) || 'Translated document'
  const chapters: EpubChapter[] = ir.sections.map((s, i) => {
    const first = s.blocks[0]
    const chTitle = first?.kind === 'heading' ? plain(ir, translations, first) : ir.sections.length === 1 ? title : (s.title ?? `Part ${i + 1}`)
    return {
      title: chTitle || `Part ${i + 1}`,
      blocks: s.blocks.map((b) => ({ kind: b.kind === 'heading' ? ('heading' as const) : ('para' as const), level: b.level, text: plain(ir, translations, b) })).filter((b) => b.text)
    }
  })
  const bytes = await buildEpub({ title, language: opts.targetLanguage?.trim() || ir.meta.language || 'en', chapters })
  await fs.writeFile(outPath, bytes)
}

export const pdfAdapter: FormatAdapter = { outputExt: '.epub', read, write }

/** Writes the Markdown form of a PDF source (headings as `#`, paragraphs separated by blank lines). */
export const writePdfMarkdown = writeMarkdown
