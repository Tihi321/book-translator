import { promises as fs } from 'node:fs'
import type { Block, BlockKind, DocFormat, DocumentIR, FormatAdapter, Section } from '../../shared/ir'

/** Plain text and Markdown. Blocks are blank-line separated paragraphs. Markdown syntax stays in the text, verbatim. */

type Piece = { type: 'raw'; raw: string } | { type: 'block'; kind: BlockKind; text: string; eol: string }

const HEADING_MD = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/
const FENCE = /^[ \t]{0,3}(```|~~~)/
const LIST_ITEM = /^[ \t]*([-*+]|\d+[.)])[ \t]+/
const CHAPTER = /^[ \t]*(chapter|part|book|prologue|epilogue|poglavlje|kapitel|chapitre|cap[ií]tulo|capitolo|teil|глава|часть)\b/i

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/(?<=\n)/)
}

function lineEol(line: string): string {
  return line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isTxtHeading(line: string): boolean {
  const t = line.trim()
  return t.length > 0 && t.length <= 80 && CHAPTER.test(t)
}

/** Splits the file into blank lines (kept raw) and blocks. Joining the pieces gives the file back. */
function tokenize(text: string, format: 'txt' | 'md'): Piece[] {
  const pieces: Piece[] = []
  let para: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (para.length === 0) return
    const last = para[para.length - 1]!
    const eol = lineEol(last)
    const body = para.join('')
    const text = body.slice(0, body.length - eol.length).replace(/\r\n/g, '\n')
    const first = para[0]!
    let kind: BlockKind = 'para'
    if (format === 'md') {
      if (FENCE.test(first)) kind = 'meta'
      else if (para.length === 1 && HEADING_MD.test(first.trim())) kind = 'heading'
      else if (LIST_ITEM.test(first)) kind = 'item'
    } else if (para.length === 1 && isTxtHeading(first)) kind = 'heading'
    pieces.push({ type: 'block', kind, text, eol })
    para = []
  }
  for (const line of splitLines(text)) {
    if (fence) {
      para.push(line)
      const t = line.trim()
      if (t.length >= fence.length && t.startsWith(fence) && /^(`+|~+)$/.test(t)) {
        fence = null
        flush()
      }
      continue
    }
    if (isBlank(line)) {
      flush()
      pieces.push({ type: 'raw', raw: line })
      continue
    }
    if (format === 'md') {
      const f = FENCE.exec(line)
      if (f) {
        flush()
        fence = f[1]!
        para.push(line)
        continue
      }
      if (HEADING_MD.test(line.trim())) {
        flush()
        para.push(line)
        flush()
        continue
      }
    } else if (isTxtHeading(line)) {
      flush()
      para.push(line)
      flush()
      continue
    }
    para.push(line)
  }
  flush()
  return pieces
}

function headingText(text: string, format: DocFormat): string {
  if (format === 'md') {
    const m = HEADING_MD.exec(text.trim())
    return m ? m[2]!.trim() : text.trim()
  }
  return text.trim()
}

function startsSection(block: Block, format: DocFormat): boolean {
  if (block.kind !== 'heading') return false
  if (format === 'md') {
    const m = HEADING_MD.exec(block.text.trim())
    return !!m && m[1]!.length <= 2
  }
  return true
}

function formatOf(path: string): 'txt' | 'md' {
  return /\.(md|markdown)$/i.test(path) ? 'md' : 'txt'
}

export function parseText(text: string, format: 'txt' | 'md'): DocumentIR {
  const sections: Section[] = []
  let current: Section | null = null
  let n = 0
  let title: string | undefined
  for (const p of tokenize(text, format)) {
    if (p.type !== 'block') continue
    const block: Block = { id: `b${++n}`, kind: p.kind, text: p.text, tags: [] }
    if (block.kind === 'heading' && format === 'md' && !title && /^#[ \t]/.test(block.text)) title = headingText(block.text, format)
    if (startsSection(block, format) || !current) {
      current = { id: `s${sections.length + 1}`, blocks: [] }
      if (startsSection(block, format)) current.title = headingText(block.text, format)
      sections.push(current)
    }
    current.blocks.push(block)
  }
  return { format, meta: { title }, sections }
}

/** Rebuilds the file from the source text, replacing blocks that have a translation. Blank lines and line endings are kept. */
export function renderText(source: string, format: 'txt' | 'md', translations: Map<string, string>): string {
  let n = 0
  let out = ''
  const docEol = /\r\n/.test(source) ? '\r\n' : '\n'
  for (const p of tokenize(source, format)) {
    if (p.type === 'raw') {
      out += p.raw
      continue
    }
    const t = translations.get(`b${++n}`)
    if (t === undefined) out += p.text.replace(/\n/g, docEol) + p.eol
    else out += t.replace(/\r?\n/g, docEol) + p.eol
  }
  return out
}

export const textAdapter: FormatAdapter = {
  async read(path) {
    const raw = await fs.readFile(path, 'utf8')
    return parseText(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw, formatOf(path))
  },
  async write(ir, translations, srcPath, outPath) {
    const raw = await fs.readFile(srcPath, 'utf8')
    const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : ''
    const text = bom ? raw.slice(1) : raw
    await fs.writeFile(outPath, bom + renderText(text, ir.format === 'md' ? 'md' : 'txt', translations), 'utf8')
  }
}
