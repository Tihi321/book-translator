import { createHash } from 'node:crypto'
import { existsSync, promises as fs, statSync } from 'node:fs'
import path from 'node:path'
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import type { Scalar, YAMLMap } from 'yaml'
import type { Block, BlockKind, DocumentIR, FormatAdapter, InlineTag, Section, WriteOptions } from '../../shared/ir'
import { splitFrontmatter } from '../../shared/md'
import { stripTags } from './inline'

/**
 * Scriptorium visual-novel book folders (docs/visual-novel.md in Scriptorium): `book.md`, `outline.md`, `chapters/*.md`, `bible/bible.md`,
 * `cover-brief.md`, read as one document and written back as a folder with the same layout.
 *
 * Every text span is one block, so a line stays a line and the script keeps its line count. What is translated:
 * - frontmatter values: `title`, `blurb`, `summary`, and in `chapters[]` `title`, `summary`, `ending`, `choices[].text` (other keys stay)
 * - chapter scripts: narration, spoken text, the place and time of `SCENE:` lines, `#` headings
 * - the body of `outline.md`, line by line (list markers stay)
 * What stays as it is: `SCENE:`, `ON SCREEN:` lines (names and looks), speaker tags with their expression, `Narration:`, `---`, stage
 * directions, the body of `book.md`, and `bible/bible.md` and `cover-brief.md`, which are the art reference for the pictures (VN Studio
 * reuses the original's pictures for an edition, and character names have to match the speaker tags).
 */

/** Script patterns of Scriptorium (with the Croatian keywords VN Studio also reads). Each has prefix, text and suffix groups. */
const BREAK = /^\s*([-*_])(?:\s*\1){2,}\s*$/
const HEADING = /^(\s*#{1,6}\s+)(.*?)(\s*#*\s*)$/
const SCENE = /^(\s*\**\s*(?:scene|scena)\s*:\s*\**\s*)(.+?)(\s*\**\s*)$/iu
const CAST = /^\s*\**\s*(?:on screen|na ekranu)\s*:/iu
const NARRATION = /^(\s*\**\s*(?:narration|narrator|naracija|pripovjeda[čc])\s*\**(?:\s*\([^)]*\))?\s*:\**\s*)(.*?)(\s*)$/iu
const LINE = /^(\s*\**([\p{Lu}][\p{Lu}\p{N}'’ .-]{0,40}?)\**(?:\s*\([^)]{1,120}\))?\s*:\**\s+)(.+?)(\s*)$/u
const DIRECTION_ONLY = /^\s*\**([\p{Lu}][\p{Lu}\p{N}'’ ./-]{0,40}?)\**\s*[:.]?\**\s*$/u
const DIRECTION = /^(?:(?:(?:SMASH|MATCH|JUMP|HARD|QUICK) )?CUT(?: (?:TO|BACK TO|NA))?|FADE(?: (?:IN|OUT|TO(?: (?:BLACK|WHITE))?|U CRNO))?|DISSOLVE(?: TO)?|(?:INT|EXT)(?:[ ./].*)?|REZ(?: NA)?|PRIJELAZ(?: NA)?|ZATAMNJENJE)$/u
const LIST = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*?)(\s*)$/

/** What a script line is. Lines whose class would change after translation keep the source text. */
type LineClass = 'blank' | 'break' | 'heading' | 'scene' | 'cast' | 'direction' | 'line' | 'narration'

interface LineParts {
  cls: LineClass
  /** Kept as it is. */
  prefix: string
  /** The words to translate ('' for a line that is kept whole). */
  text: string
  suffix: string
  /** The speaker tag of a spoken line (`PETRA (grumpy):`), shown to the translator. */
  speaker?: string
}

const whole = (cls: LineClass, line: string): LineParts => ({ cls, prefix: line, text: '', suffix: '' })

function isDirection(label: string): boolean {
  const l = label.replace(/\*+/g, '').replace(/[.:]+$/, '').replace(/\s+/g, ' ').trim().toUpperCase()
  return !!l && DIRECTION.test(l)
}

/** Splits one script line (no line ending) into the kept marker and the text to translate. */
export function classifyScriptLine(line: string): LineParts {
  if (line.trim() === '') return whole('blank', line)
  if (BREAK.test(line)) return whole('break', line)
  let m = HEADING.exec(line)
  if (m) return { cls: 'heading', prefix: m[1]!, text: m[2]!, suffix: m[3]! }
  m = SCENE.exec(line)
  if (m) return { cls: 'scene', prefix: m[1]!, text: m[2]!, suffix: m[3]! }
  if (CAST.test(line)) return whole('cast', line)
  m = NARRATION.exec(line)
  if (m) return m[2] ? { cls: 'narration', prefix: m[1]!, text: m[2], suffix: m[3]! } : whole('narration', line)
  const d = DIRECTION_ONLY.exec(line)
  if (d && isDirection(d[1]!)) return whole('direction', line)
  m = LINE.exec(line)
  if (m) return { cls: 'line', prefix: m[1]!, text: m[3]!, suffix: m[4]!, speaker: m[1]!.trim() }
  const lead = /^\s*/.exec(line)![0]
  const trail = /\s*$/.exec(line)![0]
  return { cls: 'narration', prefix: lead, text: line.slice(lead.length, line.length - trail.length), suffix: trail }
}

/** A line of outline prose: list markers and heading hashes stay. */
function classifyProseLine(line: string): LineParts {
  if (line.trim() === '') return whole('blank', line)
  const m = HEADING.exec(line) ?? LIST.exec(line)
  if (m) return { cls: 'narration', prefix: m[1]!, text: m[2]!, suffix: m[3]! }
  const lead = /^\s*/.exec(line)![0]
  const trail = /\s*$/.exec(line)![0]
  return { cls: 'narration', prefix: lead, text: line.slice(lead.length, line.length - trail.length), suffix: trail }
}

// ---- spans ----

/** A piece of a file: kept as it is, or a text the translator gets. Joining the `source` of all spans gives the file back. */
type Span =
  | { type: 'raw'; source: string }
  | { type: 'text'; source: string; kind: BlockKind; text: string; tags: InlineTag[]; render: (translation: string) => string | undefined }

const SPEAKER_TAG: InlineTag = { n: 1, kind: 'pair', data: 'speaker' }

/** One line (with its line ending) as spans. `script`: a chapter script; `prose`: plain lines (outline). */
function lineSpans(line: string, mode: 'script' | 'prose'): Span[] {
  const eol = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
  const body = line.slice(0, line.length - eol.length)
  const parts = mode === 'script' ? classifyScriptLine(body) : classifyProseLine(body)
  if (!parts.text.trim()) return [{ type: 'raw', source: line }]
  const { prefix, suffix, speaker, cls } = parts
  const kind: BlockKind = cls === 'heading' ? 'heading' : 'para'
  // a spoken line carries its speaker tag as an inline pair, so the translator knows who speaks (gender, voice); the tag is dropped again
  const text = speaker ? `<1>${speaker}</1> ${parts.text}` : parts.text
  const render = (translation: string): string | undefined => {
    let t = translation
    if (speaker) t = dropSpeaker(t, speaker)
    t = oneLine(stripTags(t))
    if (!t) return undefined
    // a translation that would read as another kind of line (a narration that now looks like `NAME: ...`) keeps the source line
    if (mode === 'script') {
      const again = classifyScriptLine(prefix + t + suffix)
      if (again.cls !== cls || again.prefix !== prefix) return undefined
    }
    return t + suffix + eol
  }
  return [
    { type: 'raw', source: prefix },
    { type: 'text', source: parts.text + suffix + eol, kind, text, tags: speaker ? [SPEAKER_TAG] : [], render }
  ]
}

/** Removes the speaker tag from a translated spoken line: the `<1>...</1>` pair, or a leading `NAME (..):` when the tags were lost. */
function dropSpeaker(text: string, speaker: string): string {
  if (/<1>[\s\S]*?<\/1>/.test(text)) return text.replace(/\s*<1>[\s\S]*?<\/1>\s*/, ' ')
  const label = /^\**\s*([^(:*]+?)\s*\**\s*(?:\(|:)/.exec(speaker)?.[1]
  if (!label) return text
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`^\\s*\\**\\s*${esc}\\s*\\**(?:\\s*\\([^)]*\\))?\\s*:\\**\\s*`, 'iu'), '')
}

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim()

function bodySpans(body: string, mode: 'script' | 'prose' | 'copy'): Span[] {
  if (mode === 'copy' || body === '') return [{ type: 'raw', source: body }]
  return body.split(/(?<=\n)/).flatMap((l) => lineSpans(l, mode))
}

// ---- frontmatter ----

const TOP_KEYS: Record<string, BlockKind> = { title: 'heading', blurb: 'para', summary: 'para' }
const CHAPTER_KEYS: Record<string, BlockKind> = { title: 'heading', summary: 'para', ending: 'para' }

interface Target {
  node: Scalar
  kind: BlockKind
  inFlow: boolean
}

function stringTarget(node: unknown, kind: BlockKind, inFlow: boolean, out: Target[]): void {
  if (isScalar(node) && typeof node.value === 'string' && node.value.trim() && node.range) out.push({ node, kind, inFlow })
}

/** The scalars to translate in a frontmatter mapping. */
function frontmatterTargets(map: YAMLMap): Target[] {
  const out: Target[] = []
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : ''
    if (TOP_KEYS[key]) stringTarget(pair.value, TOP_KEYS[key], !!map.flow, out)
    if (key !== 'chapters' || !isSeq(pair.value)) continue
    for (const ch of pair.value.items) {
      if (!isMap(ch)) continue
      for (const p of ch.items) {
        const k = isScalar(p.key) ? String(p.key.value) : ''
        if (CHAPTER_KEYS[k]) stringTarget(p.value, CHAPTER_KEYS[k], !!ch.flow, out)
        if (k !== 'choices' || !isSeq(p.value)) continue
        for (const c of p.value.items) {
          if (!isMap(c)) continue
          for (const cp of c.items) if (isScalar(cp.key) && cp.key.value === 'text') stringTarget(cp.value, 'item', !!c.flow, out)
        }
      }
    }
  }
  return out.sort((a, b) => a.node.range![0] - b.node.range![0])
}

/** A YAML scalar for `text` in the place of the source scalar: plain when that reads back the same, else double-quoted. */
export function yamlScalar(text: string, style: Scalar['type'], inFlow: boolean): string {
  const readsBack = (s: string) => {
    try {
      const v = parseYaml(inFlow ? `{k: ${s}}` : `k: ${s}`) as { k?: unknown }
      return v?.k === text
    } catch {
      return false
    }
  }
  if (style === 'QUOTE_SINGLE') {
    const s = `'${text.replace(/'/g, "''")}'`
    if (readsBack(s)) return s
  }
  if (style === 'PLAIN' || style === undefined) {
    const s = stringifyYaml(text, { lineWidth: 0 }).trimEnd()
    if (s === text && !(inFlow && /[,[\]{}]/.test(text)) && readsBack(s)) return s
  }
  return JSON.stringify(text)
}

/** The frontmatter text (between the `---` lines) as spans. */
function frontmatterSpans(yamlText: string): Span[] {
  let doc
  try {
    doc = parseDocument(yamlText)
  } catch {
    return [{ type: 'raw', source: yamlText }]
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [{ type: 'raw', source: yamlText }]
  const spans: Span[] = []
  let pos = 0
  for (const t of frontmatterTargets(doc.contents)) {
    const [start, end] = t.node.range!
    if (start < pos) continue
    const source = yamlText.slice(start, end)
    // a block scalar's range takes in its last line ending
    const trail = source.slice(source.trimEnd().length)
    const value = t.node.value as string
    spans.push({ type: 'raw', source: yamlText.slice(pos, start) })
    spans.push({
      type: 'text',
      source,
      kind: t.kind,
      text: oneLine(value),
      tags: [],
      render: (translation) => {
        const v = oneLine(stripTags(translation))
        return v ? yamlScalar(v, t.node.type, t.inFlow) + trail : undefined
      }
    })
    pos = end
  }
  spans.push({ type: 'raw', source: yamlText.slice(pos) })
  return spans
}

const OPEN = /^---[ \t]*\r?\n/
const CLOSE = /^(?:---|\.\.\.)[ \t]*\r?$/m

/** A markdown file as spans: the frontmatter values, then the body in `mode`. */
function fileSpans(text: string, mode: 'script' | 'prose' | 'copy'): Span[] {
  const open = OPEN.exec(text)
  if (!open) return bodySpans(text, mode)
  const rest = text.slice(open[0].length)
  const close = CLOSE.exec(rest)
  if (!close) return bodySpans(text, mode)
  const yamlText = rest.slice(0, close.index)
  const nl = rest.indexOf('\n', close.index)
  const closeLine = nl === -1 ? rest.slice(close.index) : rest.slice(close.index, nl + 1)
  const body = nl === -1 ? '' : rest.slice(nl + 1)
  return [{ type: 'raw', source: open[0] }, ...frontmatterSpans(yamlText), { type: 'raw', source: closeLine }, ...bodySpans(body, mode)]
}

// ---- the folder ----

type FileMode = 'script' | 'prose' | 'head' | 'copy'

interface VnFile {
  /** Path relative to the book folder, with `/`. */
  rel: string
  mode: FileMode
}

const chapterNumber = (name: string) => Number(/(\d+)/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER)

/** True for a folder with `book.md` and a `chapters/` folder (a Scriptorium book). */
export function isVnFolder(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(path.join(dir, 'book.md')) && statSync(path.join(dir, 'chapters')).isDirectory()
  } catch {
    return false
  }
}

/** The files of a book folder that are read or copied, in order: book, outline, chapters by number, then bible and cover brief. */
export async function vnFiles(dir: string): Promise<VnFile[]> {
  const files: VnFile[] = []
  const has = (rel: string) => existsSync(path.join(dir, rel))
  if (has('book.md')) files.push({ rel: 'book.md', mode: 'head' })
  if (has('outline.md')) files.push({ rel: 'outline.md', mode: 'prose' })
  const chapters = (await fs.readdir(path.join(dir, 'chapters'), { withFileTypes: true }))
    .filter((d) => d.isFile() && /\.(md|markdown)$/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => chapterNumber(a) - chapterNumber(b) || a.localeCompare(b))
  for (const c of chapters) files.push({ rel: `chapters/${c}`, mode: 'script' })
  if (has('bible/bible.md')) files.push({ rel: 'bible/bible.md', mode: 'copy' })
  else if (has('bible.md')) files.push({ rel: 'bible.md', mode: 'copy' })
  if (has('cover-brief.md')) files.push({ rel: 'cover-brief.md', mode: 'copy' })
  return files
}

/** sha256 over the names and contents of the book's files, so the same book gives the same project. */
export async function hashVnFolder(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const f of await vnFiles(dir)) {
    h.update(f.rel + '\0')
    h.update(await fs.readFile(path.join(dir, f.rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

async function readText(file: string): Promise<{ bom: string; text: string }> {
  const raw = await fs.readFile(file, 'utf8')
  return raw.charCodeAt(0) === 0xfeff ? { bom: '﻿', text: raw.slice(1) } : { bom: '', text: raw }
}

function spansOf(text: string, mode: FileMode): Span[] {
  if (mode === 'copy') return [{ type: 'raw', source: text }]
  return fileSpans(text, mode === 'head' ? 'copy' : mode)
}

/** The bold names of `## Characters` in the bible: they stay as they are in the translation. */
export function bibleNames(bible: string): string[] {
  const names: string[] = []
  let inChars = false
  for (const line of bible.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      inChars = /^(characters|likovi)$/i.test(h[1]!.trim())
      continue
    }
    const m = inChars ? /^\s*[-*+]\s+\*\*(.+?)\*\*/.exec(line) : null
    if (m && m[1]!.trim()) names.push(m[1]!.trim())
  }
  return names
}

// ---- localized character names ----

/** How a name map is looked up: case, spacing and Unicode form do not matter (the same rule as the glossary's `normalizeTerm`). */
const nameKey = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

/** `text` in capitals for a language code (`hr`), or for no particular language when the code is not one (`Croatian`). */
function upper(text: string, lang?: string): string {
  try {
    return text.toLocaleUpperCase(lang)
  } catch {
    return text.toUpperCase()
  }
}

/** The kept start of a spoken line, split: before the name, the name, after it (bold marks, expression, colon). */
const SPEAKER_PREFIX = /^(\s*\**)([\p{Lu}][\p{Lu}\p{N}'’ .-]{0,40}?)(\**(?:\s*\([^)]{1,120}\))?\s*:\**\s+)$/u
const CAST_LINE = /^(\s*\**\s*(?:on screen|na ekranu)\s*:\s*\**\s*)(.*?)(\s*)$/iu
/** One entry of an `ON SCREEN:` line: marks, the name, then what follows it (the look in brackets). */
const CAST_ITEM = /^(\s*\**\s*)([^(*]+?)(\s*(?:\(.*)?\**\s*)$/s

/** Splits at the commas that are outside brackets: `Petra (hat, boots), Nib` is two entries. */
function topLevelCommas(text: string): string[] {
  const items: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      items.push(cur)
      cur = ''
    } else cur += ch
  }
  items.push(cur)
  return items
}

/**
 * Writes localized character names into a chapter body: the name of every spoken line (in capitals, with the expression and bold marks as they
 * were) and the names in `ON SCREEN:` lines. `names` maps the lower-cased source name to the new one. Narration, scenes and the other lines stay.
 * A name that would stop its line from being a spoken line (no capitals in the language, a colon or bracket in it) keeps its source form, with
 * one warning per name. The line endings and the number of lines stay.
 */
export function localizeScriptNames(text: string, names: Record<string, string>, lang?: string, onWarning?: (message: string) => void): string {
  const warned = new Set<string>()
  const keep = (label: string, target: string, what: string) => {
    if (warned.has(label)) return
    warned.add(label)
    onWarning?.(`the name ${label} cannot be written as ${what} as "${target}", it keeps its source form there`)
  }
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const eol = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
      const body = line.slice(0, line.length - eol.length)
      const parts = classifyScriptLine(body)
      if (parts.cls === 'line') {
        const m = SPEAKER_PREFIX.exec(parts.prefix)
        const target = m ? names[nameKey(m[2]!)]?.trim() : undefined
        if (!m || !target) return line
        const prefix = m[1]! + upper(target, lang) + m[3]!
        const rest = parts.text + parts.suffix
        const again = classifyScriptLine(prefix + rest)
        if (again.cls !== 'line' || again.prefix !== prefix) {
          keep(m[2]!.trim(), target, 'a speaker tag')
          return line
        }
        return prefix + rest + eol
      }
      if (parts.cls === 'cast') {
        const c = CAST_LINE.exec(body)
        if (!c) return line
        const items = topLevelCommas(c[2]!).map((item) => {
          const m = CAST_ITEM.exec(item)
          const target = m ? names[nameKey(m[2]!)]?.trim() : undefined
          if (!m || !target) return item
          if (/[,()]/.test(target)) {
            keep(m[2]!.trim(), target, 'a name on screen')
            return item
          }
          return m[1]! + target + m[3]!
        })
        return c[1]! + items.join(',') + c[3]! + eol
      }
      return line
    })
    .join('')
}

/** Renames the `- **Name**` bullets under `## Characters` (or `## Likovi`) of the bible. The order, the descriptions and everything else stay. */
export function localizeBible(text: string, names: Record<string, string>): string {
  let inChars = false
  return text
    .split(/(?<=\n)/)
    .map((line) => {
      const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.replace(/\r?\n$/, ''))
      if (h) {
        inChars = /^(characters|likovi)$/i.test(h[1]!.trim())
        return line
      }
      if (!inChars) return line
      return line.replace(/^(\s*[-*+]\s+\*\*)(.+?)(\*\*)/, (all, open: string, name: string, close: string) => {
        const target = names[nameKey(name)]?.trim()
        return target ? open + target + close : all
      })
    })
    .join('')
}

/** Reads a book folder: one section per translated file (book, outline, each chapter), one block per text span. */
export async function readVnFolder(dir: string): Promise<DocumentIR> {
  const sections: Section[] = []
  let n = 0
  let title: string | undefined
  let names: string[] = []
  for (const f of await vnFiles(dir)) {
    const { text } = await readText(path.join(dir, f.rel))
    if (f.mode === 'copy') {
      if (f.rel.endsWith('bible.md')) names = bibleNames(text)
      continue
    }
    const blocks: Block[] = []
    let sectionTitle: string | undefined
    for (const s of spansOf(text, f.mode)) {
      if (s.type !== 'text') continue
      blocks.push({ id: `b${++n}`, kind: s.kind, text: s.text, tags: s.tags })
      if (s.kind === 'heading' && sectionTitle === undefined) sectionTitle = s.text
    }
    if (f.rel === 'book.md') title = sectionTitle
    sections.push({ id: `s${sections.length + 1}`, title: f.mode === 'script' ? (sectionTitle ?? f.rel) : f.rel, blocks })
  }
  return { format: 'vn', meta: { title, names }, sections }
}

/** Writes the translated book folder: the translated files with every line in place, the others copied. */
export async function writeVnFolder(translations: Map<string, string>, srcDir: string, outDir: string, opts: WriteOptions = {}): Promise<void> {
  let n = 0
  // localized names: a warning about a name comes once, not once per chapter
  const names = opts.names && Object.keys(opts.names).length > 0 ? opts.names : undefined
  const told = new Set<string>()
  const nameWarning = (message: string) => {
    if (told.has(message)) return
    told.add(message)
    opts.onWarning?.(message)
  }
  for (const f of await vnFiles(srcDir)) {
    const src = path.join(srcDir, f.rel)
    const out = path.join(outDir, f.rel)
    await fs.mkdir(path.dirname(out), { recursive: true })
    if (f.mode === 'copy') {
      if (names && f.rel.endsWith('bible.md')) {
        const bible = await readText(src)
        await fs.writeFile(out, bible.bom + localizeBible(bible.text, names), 'utf8')
      } else await fs.copyFile(src, out)
      continue
    }
    const { bom, text } = await readText(src)
    let result = ''
    for (const s of spansOf(text, f.mode)) {
      if (s.type === 'raw') {
        result += s.source
        continue
      }
      const id = `b${++n}`
      const t = translations.get(id)
      const rendered = t === undefined ? undefined : s.render(t)
      if (t !== undefined && rendered === undefined) opts.onWarning?.(`${f.rel}: the translation of ${id} is empty or would change the kind of script line, the source text was kept: ${oneLine(t).slice(0, 80)}`)
      result += rendered ?? s.source
    }
    if (names && f.mode === 'script') {
      const body = splitFrontmatter(result).body
      result = result.slice(0, result.length - body.length) + localizeScriptNames(body, names, opts.targetLanguage, nameWarning)
    }
    await fs.writeFile(out, bom + result, 'utf8')
  }
}

export const vnAdapter: FormatAdapter = {
  outputExt: '',
  read: (dir) => readVnFolder(dir),
  write: (_ir, translations, srcDir, outDir, opts) => writeVnFolder(translations, srcDir, outDir, opts)
}

const VN_NOTE_RULES = `## Visual-novel script
This book is a visual-novel script. Every segment is one line of it: a narration line, a spoken line, the place and time of a scene, a chapter title, or a choice the player picks. Keep every segment one line.
A segment that starts with a tag such as <1>PETRA (grumpy):</1> is spoken by that character with that expression. Copy the tag and its content unchanged and translate only the words after it, in that character's voice and with the grammatical gender of the speaker.`

/** What the translator is told about a visual-novel script, with the book brief. */
export const VN_BRIEF_NOTE = `${VN_NOTE_RULES}
Character names stay exactly as in the source; they must match the speaker tags.`

/** The same for a project with `localizeNames`: the names come from the glossary, and the app writes them into the speaker tags. */
export const VN_BRIEF_NOTE_LOCALIZED = `${VN_NOTE_RULES}
Character names are localized: write every name as the glossary gives it, in narration and in what characters say. Still copy the speaker tag such as <1>PETRA (grumpy):</1> unchanged; the app writes the localized name into it.`
