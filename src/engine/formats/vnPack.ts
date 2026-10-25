import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { Block, BlockKind, DocumentIR, InlineTag, Section, FormatAdapter, WriteOptions } from '../../shared/ir'
import { stripTags, validateTags } from './inline'

/**
 * Visual-novel book packs v2 (HUB-16 / SCP-45 / VNO-46, the contract in creative-hub `.claude/tickets/HUB-16-vn-pack/contract.md`).
 *
 * A pack is a language-independent template (`vn/pack.json`: structure, IDs, art fields) plus one text catalog per language
 * (`vn/text/<lang>.json`: display text only). This adapter translates **only the catalog**: one block per catalog key, its id the catalog path.
 * The template is read, validated and copied byte for byte; it is never parsed into the IR and never written differently.
 *
 * Export writes the hand-off bundle `<slug>.<lang>/` with `edition.json`, the byte-identical `vn/pack.json`, `vn/text/<lang>.json` and the bare
 * `catalog.json` (a catalog file alone is also a valid `vno_add_edition` source).
 */

export const VN_PACK_FORMAT = 'vn-pack'
export const VN_TEXT_FORMAT = 'vn-text'
export const VN_BUNDLE_FORMAT = 'vn-edition-bundle'
export const VN_PACK_VERSION = 2
export const VN_BUNDLE_VERSION = 2

// ---- the shape of a pack ----

export interface VnPackBook {
  slug: string
  format: string
  kind: 'linear' | 'choice'
  primaryLang: string
  genre?: string
  style?: string
  author?: string
  coverBrief?: string
  sourceHash?: string
}

export interface VnPackCharacter {
  key: string
  looks?: string
  voice?: string
  aliasKeys: string[]
}

export interface VnPackPlace {
  key: string
  name?: string
  looks?: string
}

export interface VnPackCastEntry {
  charKey: string
  look?: string
}

export interface VnPackBeat {
  id: string
  type: 'cast' | 'line' | 'narration' | 'puzzle'
  cast?: VnPackCastEntry[]
  speakerKey?: string
  /** A line spoken under an alias: the display name comes from `characterNames[aliasKey]` (the catalog key is `<charKey>#<n>`). */
  aliasKey?: string
  expression?: string
  rawExpression?: string
  puzzle?: string
}

export interface VnPackScene {
  id: string
  placeKey?: string
  placeText?: string
  time?: string
  description?: string
  breakBefore?: boolean
  beats: VnPackBeat[]
}

export interface VnPackChoice {
  index: number
  to?: number
}

export interface VnPackChapter {
  n: number
  isEnding: boolean
  choices: VnPackChoice[]
  scenes: VnPackScene[]
}

export interface VnPackPuzzle {
  key: string
  kind?: string
  chapter?: number
}

export interface VnPack {
  format: string
  version: number
  packHash: string
  book: VnPackBook
  characters: VnPackCharacter[]
  places: VnPackPlace[]
  expressions: string[]
  chapters: VnPackChapter[]
  puzzles: VnPackPuzzle[]
}

export interface VnCatalogPuzzle {
  names?: Record<string, string>
  text?: Record<string, string>
  [key: string]: unknown
}

export interface VnCatalog {
  format: string
  version: number
  lang: string
  packHash: string
  title: string
  blurb?: string
  chapterTitles: Record<string, string>
  sceneTitles?: Record<string, string>
  choiceTexts: Record<string, string>
  endings: Record<string, string>
  characterNames: Record<string, string>
  beats: Record<string, string>
  puzzles: Record<string, VnCatalogPuzzle>
  [key: string]: unknown
}

/** What `writeVnPack` wrote. */
export interface VnPackWriteReport {
  /** The bundle folder. */
  path: string
  /** The bare catalog (`catalog.json` in the bundle). */
  catalogPath: string
  /** The language of the catalog (`edition.json`'s `lang`). */
  lang: string
  /** How many catalog values the bundle carries. */
  keys: number
  warnings: string[]
}

// ---- JSON and hashing ----

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function fail(message: string): never {
  throw new Error(`visual-novel pack: ${message}`)
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/**
 * The contract's canonical JSON: object keys sorted recursively, arrays in their order, `JSON.stringify` with no whitespace.
 * `packHash` is the SHA-256 of the canonical pack object without its `packHash` key.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  return JSON.stringify(value) ?? 'null'
}

/** `sha256:` prefix allowed on stored hashes; the comparison is of the hex digest. */
const hashHex = (s: string): string => s.trim().toLowerCase().replace(/^sha256:/, '')

export function sameHash(a: string, b: string): boolean {
  return hashHex(a) === hashHex(b)
}

export function packHashOf(pack: Json): string {
  const { packHash: _ignored, ...rest } = pack
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
}

const short = (hash: string) => hashHex(hash).slice(0, 12)

// ---- what a catalog value may be ----

const STRUCTURAL_LABELS = ['SCENE', 'ON SCREEN', 'NARRATION', 'CG', 'INSERT', 'SFX', 'AMBIENCE', 'CLUE', 'EVIDENCE', 'PUZZLE', 'TESTIMONY'] as const
const LABEL_AT_START = new RegExp(`^(?:${STRUCTURAL_LABELS.map((l) => l.replace(/ /g, '\\s+')).join('|')})\\s*:`, 'i')
/** A scene (`ch01.s01`) or beat (`ch01.s01.b003`) id, the contract's opaque structure. */
const SCENE_OR_BEAT_ID = /(?:^|[^\p{L}\p{N}_])ch\d{2}\.s\d{2}(?:\.b\d{3})?(?=$|[^\p{L}\p{N}_])/u
const PLACEHOLDER_TAG = /<\/?\d+\/?>/

/**
 * Why a catalog value cannot be used, or undefined. The contract (§5): single line, non-empty, no structural label at the start (case-insensitive,
 * markdown emphasis allowed before it), no beat/scene id, no placeholder tags (inline markdown emphasis is fine).
 */
export function catalogValueProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'is not a string'
  if (!value.trim()) return 'is empty'
  if (/[\r\n]/.test(value)) return 'is more than one line'
  if (PLACEHOLDER_TAG.test(value)) return 'contains an inline placeholder tag'
  const lead = value.replace(/^[\s*_]+/, '')
  const label = LABEL_AT_START.exec(lead)
  if (label) return `begins with the structural label "${label[0].replace(/\s+/g, ' ').trim()}"`
  if (SCENE_OR_BEAT_ID.test(value)) return 'contains a scene or beat id'
  return undefined
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The name in a leading speaker tag (`<1>PETRA (worried):</1> ...`), if there is one. */
function tagSpeakerName(segment: string): string | undefined {
  const m = /^<1>([\s\S]*?)<\/1>/.exec(segment)
  if (!m) return undefined
  const label = /^\**\s*([^(:*<]+?)\s*\**\s*(?:\(|:)/.exec(m[1]!)
  return label?.[1]?.trim() || m[1]!.trim()
}

/**
 * The display text of a translated segment: the `<1>…</1>` speaker tag (or a leading `Name (expression):` when the tags were lost) and any inline
 * placeholder tags are removed. What is left is the catalog value.
 */
export function stripSpeakerContext(value: string, speaker?: string): string {
  let out = value
  if (/<1>[\s\S]*?<\/1>/.test(out)) out = out.replace(/^\s*<1>[\s\S]*?<\/1>\s*/, '')
  const name = speaker ?? tagSpeakerName(value)
  if (name) out = out.replace(new RegExp(`^\\s*\\**\\s*${escapeRegExp(name)}\\s*\\**\\s*(?:\\([^)]*\\))?\\s*:\\**\\s*`, 'iu'), '')
  return stripTags(out)
}

/** Why a translated segment cannot become a catalog value, or undefined (the structural checks on its display text). */
export function vnPackSegmentProblem(segment: string, translation: string): string | undefined {
  const value = stripSpeakerContext(translation, tagSpeakerName(segment)).trim()
  return catalogValueProblem(value)
}

// ---- detection ----

const PACK_REL = 'vn/pack.json'
const textRel = (lang: string) => `vn/text/${lang}.json`

function readJsonFile(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The pack's `book.primaryLang`, read leniently (detection must work on a pack whose content is wrong, so the reader can say why). */
function packPrimaryLang(dir: string): string | undefined {
  try {
    const raw = readJsonFile(path.join(dir, PACK_REL))
    if (isObject(raw) && isObject(raw.book)) return text(raw.book.primaryLang)
  } catch {
    // not JSON (or not there): detection falls back to any catalog file
  }
  return undefined
}

/**
 * True for a folder with `vn/pack.json` and a catalog (`vn/text/<sourceLang>.json`) - a visual-novel pack v2. Checked **before** the legacy
 * `isVnFolder` test, so a Scriptorium book folder that has a pack is translated as a pack (the authored chapters are ignored).
 */
export function isVnPack(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
    const packFile = path.join(dir, PACK_REL)
    if (!statSync(packFile).isFile()) return false
    const lang = packPrimaryLang(dir)
    if (lang) return existsSync(path.join(dir, textRel(lang)))
    const textDir = path.join(dir, 'vn', 'text')
    return statSync(textDir).isDirectory() && readdirSync(textDir).some((n) => n.endsWith('.json'))
  } catch {
    return false
  }
}

/** The pack's slug, for the export folder: `<slug>.<lang>`. */
export async function vnPackSlug(dir: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, PACK_REL), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isObject(parsed) && isObject(parsed.book)) return text(parsed.book.slug)
  } catch {
    // not a pack: the caller falls back to the folder name
  }
  return undefined
}

/**
 * The project's source hash for a pack: SHA-256 over `vn/pack.json` and the source catalog only (`rel + "\0" + bytes + "\0"`, the same shape as
 * `hashVnFolder`). Other editions and the authored files are not part of it, so adding a translated catalog never starts a new project and any
 * change to the pack starts one.
 */
export async function hashVnPackFolder(dir: string): Promise<string> {
  const raw = await fs.readFile(path.join(dir, PACK_REL), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`${PACK_REL} is not valid JSON`)
  }
  if (!isObject(parsed) || !isObject(parsed.book)) fail(`${PACK_REL} has no book`)
  const lang = text(parsed.book.primaryLang) ?? fail(`${PACK_REL} has no book.primaryLang`)
  if (!existsSync(path.join(dir, textRel(lang)))) fail(`the source catalog ${textRel(lang)} is missing`)
  const h = createHash('sha256')
  for (const rel of [PACK_REL, textRel(lang)]) {
    h.update(rel + '\0')
    h.update(await fs.readFile(path.join(dir, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}

// ---- validation: pack ----

function asList(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} is not a list`)
  return value
}

function parsePack(raw: unknown): VnPack {
  const obj = isObject(raw) ? raw : fail(`${PACK_REL} is not a JSON object`)
  if (obj.format !== VN_PACK_FORMAT) fail(`${PACK_REL} format is ${JSON.stringify(obj.format)}, expected "${VN_PACK_FORMAT}"`)
  if (obj.version !== VN_PACK_VERSION) fail(`${PACK_REL} version is ${JSON.stringify(obj.version)}, this translator reads version ${VN_PACK_VERSION}`)
  const stored = text(obj.packHash) ?? fail(`${PACK_REL} has no packHash`)
  const computed = packHashOf(obj)
  if (!sameHash(stored, computed)) fail(`${PACK_REL} packHash ${short(stored)} does not match its content (${short(computed)}); the pack was changed after it was written`)

  const book = isObject(obj.book) ? obj.book : fail(`${PACK_REL} has no book`)
  const kind = book.kind
  if (kind !== 'linear' && kind !== 'choice') fail(`book.kind is ${JSON.stringify(kind)}, expected "linear" or "choice"`)
  const characters: VnPackCharacter[] = asList(obj.characters ?? [], 'characters').map((c, i) => {
    const o = isObject(c) ? c : fail(`characters[${i}] is not an object`)
    const key = text(o.key) ?? fail(`characters[${i}] has no key`)
    const aliasKeys = o.aliasKeys === undefined ? [] : asList(o.aliasKeys, `characters[${i}].aliasKeys`).map((a) => text(a) ?? fail(`characters[${i}].aliasKeys has an empty entry`))
    return { key, aliasKeys, ...(text(o.looks) ? { looks: o.looks as string } : {}), ...(text(o.voice) ? { voice: o.voice as string } : {}) }
  })
  const charKeys = new Set<string>()
  for (const c of characters) {
    if (charKeys.has(c.key)) fail(`character key "${c.key}" appears twice`)
    charKeys.add(c.key)
  }
  for (const c of characters) {
    for (const alias of c.aliasKeys) {
      if (charKeys.has(alias)) fail(`character/alias key "${alias}" appears twice`)
      charKeys.add(alias)
    }
  }
  const places: VnPackPlace[] = asList(obj.places ?? [], 'places').map((p, i) => {
    const o = isObject(p) ? p : fail(`places[${i}] is not an object`)
    return { key: text(o.key) ?? fail(`places[${i}] has no key`), ...(text(o.name) ? { name: o.name as string } : {}), ...(text(o.looks) ? { looks: o.looks as string } : {}) }
  })
  const placeKeys = new Set<string>()
  for (const p of places) {
    if (placeKeys.has(p.key)) fail(`place key "${p.key}" appears twice`)
    placeKeys.add(p.key)
  }
  const expressions = asList(obj.expressions ?? [], 'expressions').map((e) => text(e) ?? fail('expressions has an empty entry'))

  const beatIds = new Set<string>()
  const chapters: VnPackChapter[] = asList(obj.chapters ?? [], 'chapters').map((c, ci) => {
    const o = isObject(c) ? c : fail(`chapters[${ci}] is not an object`)
    const n = o.n
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) fail(`chapters[${ci}].n is not a chapter number`)
    const choices = asList(o.choices ?? [], `chapter ${n} choices`).map((x, i) => {
      const ch = isObject(x) ? x : fail(`chapter ${n} choices[${i}] is not an object`)
      const index = ch.index
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) fail(`chapter ${n} choices[${i}].index is not a number`)
      return { index, ...(typeof ch.to === 'number' ? { to: ch.to } : {}) }
    })
    const scenes = asList(o.scenes ?? [], `chapter ${n} scenes`).map((s, si) => {
      const so = isObject(s) ? s : fail(`chapter ${n} scenes[${si}] is not an object`)
      const id = text(so.id) ?? fail(`chapter ${n} scenes[${si}] has no id`)
      const beats: VnPackBeat[] = asList(so.beats ?? [], `scene ${id} beats`).map((b, bi) => {
        const bo = isObject(b) ? b : fail(`scene ${id} beats[${bi}] is not an object`)
        const beatId = text(bo.id) ?? fail(`scene ${id} beats[${bi}] has no id`)
        if (beatIds.has(beatId)) fail(`beat id "${beatId}" appears twice`)
        beatIds.add(beatId)
        const type = bo.type
        if (type !== 'cast' && type !== 'line' && type !== 'narration' && type !== 'puzzle') fail(`beat "${beatId}" has type ${JSON.stringify(type)}`)
        const beat: VnPackBeat = { id: beatId, type }
        if (type === 'line') {
          const speakerKey = text(bo.speakerKey) ?? fail(`line beat "${beatId}" has no speakerKey`)
          if (!charKeys.has(speakerKey)) fail(`line beat "${beatId}" speaks as "${speakerKey}", which is not a character of the pack`)
          beat.speakerKey = speakerKey
          // an alias reveal: the name tag comes from the alias's catalog entry, the structure still keys the speaker
          const aliasKey = text(bo.aliasKey)
          if (aliasKey) {
            if (!charKeys.has(aliasKey)) fail(`line beat "${beatId}" uses alias "${aliasKey}", which is not a character or alias of the pack`)
            beat.aliasKey = aliasKey
          }
          if (text(bo.expression)) beat.expression = bo.expression as string
          if (text(bo.rawExpression)) beat.rawExpression = bo.rawExpression as string
        }
        if (type === 'cast') {
          beat.cast = asList(bo.cast ?? [], `cast beat "${beatId}".cast`).map((x, i) => {
            const co = isObject(x) ? x : fail(`cast beat "${beatId}" cast[${i}] is not an object`)
            const charKey = text(co.charKey) ?? fail(`cast beat "${beatId}" cast[${i}] has no charKey`)
            if (!charKeys.has(charKey)) fail(`cast beat "${beatId}" shows "${charKey}", which is not a character of the pack`)
            return { charKey, ...(text(co.look) ? { look: co.look as string } : {}) }
          })
        }
        if (type === 'puzzle') beat.puzzle = text(bo.puzzle) ?? fail(`puzzle beat "${beatId}" has no puzzle key`)
        return beat
      })
      const placeKey = text(so.placeKey)
      if (placeKey && !placeKeys.has(placeKey)) fail(`scene "${id}" has place "${placeKey}", which is not a place of the pack`)
      return { id, beats, ...(placeKey ? { placeKey } : {}), ...(text(so.placeText) ? { placeText: so.placeText as string } : {}), ...(text(so.time) ? { time: so.time as string } : {}) }
    })
    return { n, isEnding: o.isEnding === true, choices, scenes }
  })
  chapters.sort((a, b) => a.n - b.n)
  const chapterNumbers = new Set<number>()
  for (const c of chapters) {
    if (chapterNumbers.has(c.n)) fail(`chapter ${c.n} appears twice`)
    chapterNumbers.add(c.n)
  }
  const sceneIds = new Set<string>()
  for (const c of chapters) for (const s of c.scenes) {
    if (sceneIds.has(s.id)) fail(`scene id "${s.id}" appears twice`)
    sceneIds.add(s.id)
  }
  const puzzles: VnPackPuzzle[] = asList(obj.puzzles ?? [], 'puzzles').map((p, i) => {
    const o = isObject(p) ? p : fail(`puzzles[${i}] is not an object`)
    return { key: text(o.key) ?? fail(`puzzles[${i}] has no key`), ...(text(o.kind) ? { kind: o.kind as string } : {}), ...(typeof o.chapter === 'number' ? { chapter: o.chapter } : {}) }
  })
  const puzzleKeys = new Set<string>()
  for (const p of puzzles) {
    if (puzzleKeys.has(p.key)) fail(`puzzle key "${p.key}" appears twice`)
    puzzleKeys.add(p.key)
  }
  for (const c of chapters) for (const s of c.scenes) for (const b of s.beats) {
    if (b.type === 'puzzle' && !puzzleKeys.has(b.puzzle!)) fail(`puzzle beat "${b.id}" names "${b.puzzle}", which is not a puzzle of the pack`)
  }
  const sourceHash = text(book.sourceHash)
  return {
    format: VN_PACK_FORMAT,
    version: VN_PACK_VERSION,
    packHash: stored,
    book: {
      slug: text(book.slug) ?? fail('book.slug is missing'),
      format: text(book.format) ?? fail('book.format is missing'),
      kind,
      primaryLang: text(book.primaryLang) ?? fail('book.primaryLang is missing'),
      ...(text(book.genre) ? { genre: book.genre as string } : {}),
      ...(text(book.style) ? { style: book.style as string } : {}),
      ...(text(book.author) ? { author: book.author as string } : {}),
      ...(text(book.coverBrief) ? { coverBrief: book.coverBrief as string } : {}),
      ...(sourceHash ? { sourceHash } : {})
    },
    characters,
    places,
    expressions,
    chapters,
    puzzles
  }
}

// ---- validation: catalog ----

function requireMap(value: unknown, what: string): Record<string, unknown> {
  return isObject(value) ? value : fail(`${what} is not an object`)
}

/** Checks one catalog value and returns it. */
function catalogValue(value: unknown, what: string): string {
  const problem = catalogValueProblem(value)
  if (problem) fail(`${what} ${problem}`)
  return value as string
}

function catalogStringMap(value: unknown, what: string): Record<string, string> {
  const map = requireMap(value, what)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(map)) out[k] = catalogValue(v, `${what}["${k}"]`)
  return out
}

/** The character and alias keys of the pack, in order. */
function characterKeys(pack: VnPack): string[] {
  const keys: string[] = []
  for (const c of pack.characters) keys.push(c.key, ...c.aliasKeys)
  return keys
}

function sceneKeys(pack: VnPack): string[] {
  return pack.chapters.flatMap((c) => c.scenes.map((s) => s.id))
}

/** Every line/narration beat id of the pack: the beats that have a catalog value. */
function beatKeys(pack: VnPack): string[] {
  const out: string[] = []
  for (const c of pack.chapters) for (const s of c.scenes) for (const b of s.beats) if (b.type === 'line' || b.type === 'narration') out.push(b.id)
  return out
}

function checkExactKeys(actual: Record<string, string>, expected: readonly string[], what: string): void {
  const have = new Set(Object.keys(actual))
  const want = new Set(expected)
  for (const k of expected) if (!have.has(k)) fail(`${what} is missing "${k}"`)
  for (const k of have) if (!want.has(k)) fail(`${what} has the unknown key "${k}"`)
}

function parseCatalog(raw: unknown, pack: VnPack): VnCatalog {
  const obj = isObject(raw) ? raw : fail('the text catalog is not a JSON object')
  if (obj.format !== VN_TEXT_FORMAT) fail(`the text catalog format is ${JSON.stringify(obj.format)}, expected "${VN_TEXT_FORMAT}"`)
  if (obj.version !== VN_PACK_VERSION) fail(`the text catalog version is ${JSON.stringify(obj.version)}, this translator reads version ${VN_PACK_VERSION}`)
  const lang = text(obj.lang) ?? fail('the text catalog has no lang')
  if (lang !== pack.book.primaryLang) fail(`the text catalog is for "${lang}", but the pack's source language is "${pack.book.primaryLang}"`)
  const stored = text(obj.packHash) ?? fail('the text catalog has no packHash')
  if (!sameHash(stored, pack.packHash)) fail(`the text catalog belongs to pack ${short(stored)}, the pack is ${short(pack.packHash)}; it was made for another pack`)

  const chapterTitles = catalogStringMap(obj.chapterTitles, 'chapterTitles')
  checkExactKeys(chapterTitles, pack.chapters.map((c) => String(c.n)), 'chapterTitles')
  const choiceTexts = catalogStringMap(obj.choiceTexts, 'choiceTexts')
  checkExactKeys(choiceTexts, pack.chapters.flatMap((c) => c.choices.map((x) => `${c.n}:${x.index}`)), 'choiceTexts')
  const endings = catalogStringMap(obj.endings, 'endings')
  checkExactKeys(endings, pack.chapters.filter((c) => c.isEnding).map((c) => String(c.n)), 'endings')
  const characterNames = catalogStringMap(obj.characterNames, 'characterNames')
  checkExactKeys(characterNames, characterKeys(pack), 'characterNames')
  const beats = catalogStringMap(obj.beats, 'beats')
  checkExactKeys(beats, beatKeys(pack), 'beats')

  let sceneTitles: Record<string, string> | undefined
  if (obj.sceneTitles !== undefined) {
    sceneTitles = catalogStringMap(obj.sceneTitles, 'sceneTitles')
    const scenes = new Set(sceneKeys(pack))
    for (const id of Object.keys(sceneTitles)) if (!scenes.has(id)) fail(`sceneTitles has the unknown scene "${id}"`)
  }
  let blurb: string | undefined
  if (obj.blurb !== undefined) blurb = catalogValue(obj.blurb, 'blurb')

  const puzzleKeys = new Set(pack.puzzles.map((p) => p.key))
  const puzzles: Record<string, VnCatalogPuzzle> = {}
  if (obj.puzzles !== undefined) {
    for (const [key, value] of Object.entries(requireMap(obj.puzzles, 'puzzles'))) {
      if (!puzzleKeys.has(key)) fail(`puzzles has the unknown puzzle "${key}"`)
      const entry = requireMap(value, `puzzles["${key}"]`)
      const out: VnCatalogPuzzle = {}
      if (entry.names !== undefined) out.names = catalogStringMap(entry.names, `puzzles["${key}"].names`)
      if (entry.text !== undefined) out.text = catalogStringMap(entry.text, `puzzles["${key}"].text`)
      for (const [k, v] of Object.entries(entry)) if (k !== 'names' && k !== 'text') out[k] = v
      puzzles[key] = out
    }
  }

  const catalog: VnCatalog = {
    ...obj,
    format: VN_TEXT_FORMAT,
    version: VN_PACK_VERSION,
    lang,
    packHash: pack.packHash,
    title: catalogValue(obj.title, 'title'),
    chapterTitles,
    choiceTexts,
    endings,
    characterNames,
    beats,
    puzzles
  }
  delete catalog.blurb
  if (blurb !== undefined) catalog.blurb = blurb
  delete catalog.sceneTitles
  if (sceneTitles !== undefined) catalog.sceneTitles = sceneTitles
  return catalog
}

// ---- reading ----

interface LoadedVnPack {
  pack: VnPack
  catalog: VnCatalog
  packBytes: Buffer
  packFile: string
  catalogFile: string
}

async function loadVnPack(dir: string): Promise<LoadedVnPack> {
  const packFile = path.join(dir, PACK_REL)
  let packBytes: Buffer
  try {
    packBytes = await fs.readFile(packFile)
  } catch {
    fail(`${PACK_REL} is missing in ${dir}`)
  }
  let rawPack: unknown
  try {
    rawPack = JSON.parse(packBytes.toString('utf8'))
  } catch {
    fail(`${PACK_REL} is not valid JSON`)
  }
  const pack = parsePack(rawPack)
  const catalogFile = path.join(dir, textRel(pack.book.primaryLang))
  let rawCatalog: unknown
  try {
    rawCatalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'))
  } catch {
    fail(`the source catalog ${textRel(pack.book.primaryLang)} is missing (or is not JSON) in ${dir}`)
  }
  return { pack, catalog: parseCatalog(rawCatalog, pack), packBytes, packFile, catalogFile }
}

// ---- the IR: one block per catalog key ----

const SPEAKER_TAG: InlineTag = { n: 1, kind: 'pair', data: 'speaker' }

const block = (id: string, kind: BlockKind, value: string, tags: InlineTag[] = []): Block => ({ id, kind, text: value, tags })

/** A catalog key: `<prefix>.<path>`. The block ids are exactly these, and they never reach the model as text. */
const chapterTitleKey = (n: number) => `chapter.${n}.title`
const choiceKey = (n: number, index: number) => `choice.${n}.${index}`
const endingKey = (n: number) => `ending.${n}`
const sceneKey = (id: string) => `scene.${id}`
const charKey = (key: string) => `char.${key}`
const beatKey = (id: string) => `beat.${id}`
const puzzleNameKey = (puzzle: string, id: string) => `puzzle.${puzzle}.name.${id}`
const puzzleTextKey = (puzzle: string, id: string) => `puzzle.${puzzle}.text.${id}`

/** The `<1>NAME (expression):</1>` context of a spoken line: the translator knows who speaks; the tag is dropped on write. */
function speakerText(name: string, expression?: string): string {
  const expr = expression?.trim()
  const label = expr && expr.toLowerCase() !== 'neutral' ? `${name} (${expr})` : name
  return `<1>${label}:</1>`
}

function buildIr(pack: VnPack, catalog: VnCatalog): DocumentIR {
  const sections: Section[] = []
  const book: Block[] = [block('title', 'heading', catalog.title)]
  if (catalog.blurb !== undefined) book.push(block('blurb', 'para', catalog.blurb))
  sections.push({ id: 'book', title: 'Book', blocks: book })

  const characters: Block[] = []
  for (const c of pack.characters) {
    characters.push(block(charKey(c.key), 'para', catalog.characterNames[c.key]!))
    for (const alias of c.aliasKeys) characters.push(block(charKey(alias), 'para', catalog.characterNames[alias]!))
  }
  if (characters.length > 0) sections.push({ id: 'characters', title: 'Characters', blocks: characters })

  for (const chapter of pack.chapters) {
    const blocks: Block[] = [block(chapterTitleKey(chapter.n), 'heading', catalog.chapterTitles[String(chapter.n)]!)]
    for (const scene of chapter.scenes) {
      const title = catalog.sceneTitles?.[scene.id]
      if (title !== undefined) blocks.push(block(sceneKey(scene.id), 'para', title))
      for (const beat of scene.beats) {
        if (beat.type !== 'line' && beat.type !== 'narration') continue
        const value = catalog.beats[beat.id]!
        if (beat.type === 'line') {
          const nameKey = beat.aliasKey ?? beat.speakerKey!
          const name = catalog.characterNames[nameKey] ?? catalog.characterNames[beat.speakerKey!] ?? beat.speakerKey!
          blocks.push(block(beatKey(beat.id), 'para', `${speakerText(name, beat.expression)} ${value}`, [SPEAKER_TAG]))
        } else blocks.push(block(beatKey(beat.id), 'para', value))
      }
    }
    for (const choice of chapter.choices) blocks.push(block(choiceKey(chapter.n, choice.index), 'item', catalog.choiceTexts[`${chapter.n}:${choice.index}`]!))
    if (chapter.isEnding) blocks.push(block(endingKey(chapter.n), 'para', catalog.endings[String(chapter.n)]!))
    sections.push({ id: `chapter-${chapter.n}`, title: `Chapter ${chapter.n}`, blocks })
  }

  const puzzles: Block[] = []
  for (const puzzle of pack.puzzles) {
    const entry = catalog.puzzles[puzzle.key]
    if (!entry) continue
    for (const id of Object.keys(entry.names ?? {}).sort()) puzzles.push(block(puzzleNameKey(puzzle.key, id), 'item', entry.names![id]!))
    for (const id of Object.keys(entry.text ?? {}).sort()) puzzles.push(block(puzzleTextKey(puzzle.key, id), 'para', entry.text![id]!))
  }
  if (puzzles.length > 0) sections.push({ id: 'puzzles', title: 'Puzzles', blocks: puzzles })

  const names: string[] = []
  const seen = new Set<string>()
  for (const key of characterKeys(pack)) {
    const name = catalog.characterNames[key]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return { format: 'vnp', meta: { title: catalog.title, language: pack.book.primaryLang, names, sourceHash: pack.packHash }, sections }
}

/** Reads a pack folder: one block per catalog value, the template and structure never translated. */
export async function readVnPack(dir: string): Promise<DocumentIR> {
  const { pack, catalog } = await loadVnPack(dir)
  return buildIr(pack, catalog)
}

// ---- writing ----

/** The display values of a catalog by block id, in their catalog order. */
function flattenCatalog(catalog: VnCatalog): Map<string, string> {
  const out = new Map<string, string>()
  out.set('title', catalog.title)
  if (catalog.blurb !== undefined) out.set('blurb', catalog.blurb)
  for (const [n, value] of Object.entries(catalog.chapterTitles)) {
    const number = Number(n)
    out.set(chapterTitleKey(number), value)
  }
  for (const [id, value] of Object.entries(catalog.sceneTitles ?? {})) out.set(sceneKey(id), value)
  for (const [key, value] of Object.entries(catalog.choiceTexts)) {
    const [n, index] = key.split(':')
    out.set(choiceKey(Number(n), Number(index)), value)
  }
  for (const [n, value] of Object.entries(catalog.endings)) out.set(endingKey(Number(n)), value)
  for (const [key, value] of Object.entries(catalog.characterNames)) out.set(charKey(key), value)
  for (const [id, value] of Object.entries(catalog.beats)) out.set(beatKey(id), value)
  for (const [puzzle, entry] of Object.entries(catalog.puzzles)) {
    for (const [id, value] of Object.entries(entry.names ?? {})) out.set(puzzleNameKey(puzzle, id), value)
    for (const [id, value] of Object.entries(entry.text ?? {})) out.set(puzzleTextKey(puzzle, id), value)
  }
  return out
}

/** The speaker display name of every line beat: the tag/label context a translation may repeat. */
function lineSpeakers(pack: VnPack, catalog: VnCatalog): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of pack.chapters) for (const s of c.scenes) for (const b of s.beats) {
    if (b.type !== 'line') continue
    out.set(beatKey(b.id), catalog.characterNames[b.aliasKey ?? b.speakerKey!] ?? catalog.characterNames[b.speakerKey!] ?? b.speakerKey!)
  }
  return out
}

const spanBeatId = (key: string): string | undefined => (key.startsWith('beat.') ? key.slice('beat.'.length) : undefined)

function beatExpression(pack: VnPack, beatId: string): string | undefined {
  for (const c of pack.chapters) for (const s of c.scenes) for (const b of s.beats) if (b.id === beatId) return b.expression
  return undefined
}

/** Builds the target catalog from the source catalog's shape, so its key set is exactly the source's. */
function targetCatalog(pack: VnPack, catalog: VnCatalog, translations: ReadonlyMap<string, string>, lang: string): { catalog: VnCatalog; written: number; missing: number; warnings: string[] } {
  const source = flattenCatalog(catalog)
  for (const id of translations.keys()) {
    if (!source.has(id)) fail(`the translation has an unknown block "${id}": the pack changed since this project was made (create a new project)`)
  }
  const speakers = lineSpeakers(pack, catalog)
  const problems: string[] = []
  const value = (key: string): string => {
    const sourceValue = source.get(key)!
    const translated = translations.get(key)
    if (translated === undefined) return sourceValue
    const speaker = speakers.get(key)
    const clean = stripSpeakerContext(translated, speaker).trim()
    const problem = catalogValueProblem(clean)
    if (problem) problems.push(`${key} ${problem}`)
    const beatId = spanBeatId(key)
    if (PLACEHOLDER_TAG.test(translated)) {
      if (beatId && speaker !== undefined) {
        const expected = `${speakerText(speaker, beatExpression(pack, beatId))} ${catalog.beats[beatId]!}`
        if (!validateTags(expected, translated).ok) problems.push(`${key} has inline tags that do not match the source`)
      } else problems.push(`${key} contains an inline placeholder tag`)
    }
    return clean
  }
  const missing = [...source.keys()].filter((key) => !translations.has(key)).length

  const book: VnCatalog = {
    format: VN_TEXT_FORMAT,
    version: VN_PACK_VERSION,
    lang,
    packHash: pack.packHash,
    title: '',
    chapterTitles: {},
    choiceTexts: {},
    endings: {},
    characterNames: {},
    beats: {},
    puzzles: {}
  }
  book.title = value('title')
  if (catalog.blurb !== undefined) book.blurb = value('blurb')
  book.chapterTitles = Object.fromEntries(pack.chapters.map((c) => [String(c.n), value(chapterTitleKey(c.n))] as [string, string]))
  if (catalog.sceneTitles !== undefined) book.sceneTitles = Object.fromEntries(Object.keys(catalog.sceneTitles).map((id) => [id, value(sceneKey(id))] as [string, string]))
  book.choiceTexts = Object.fromEntries(pack.chapters.flatMap((c) => c.choices.map((x) => [`${c.n}:${x.index}`, value(choiceKey(c.n, x.index))] as [string, string])))
  book.endings = Object.fromEntries(pack.chapters.filter((c) => c.isEnding).map((c) => [String(c.n), value(endingKey(c.n))] as [string, string]))
  book.characterNames = Object.fromEntries(characterKeys(pack).map((k) => [k, value(charKey(k))] as [string, string]))
  book.beats = Object.fromEntries(beatKeys(pack).map((id) => [id, value(beatKey(id))] as [string, string]))
  for (const puzzle of pack.puzzles) {
    const entry = catalog.puzzles[puzzle.key]
    if (!entry) continue
    const out: VnCatalogPuzzle = {}
    if (entry.names !== undefined) out.names = Object.fromEntries(Object.keys(entry.names).map((id) => [id, value(puzzleNameKey(puzzle.key, id))] as [string, string]))
    if (entry.text !== undefined) out.text = Object.fromEntries(Object.keys(entry.text).map((id) => [id, value(puzzleTextKey(puzzle.key, id))] as [string, string]))
    for (const [k, v] of Object.entries(entry)) if (k !== 'names' && k !== 'text') out[k] = v
    book.puzzles[puzzle.key] = out
  }
  // unknown top-level metadata of the source catalog is carried over unchanged (readers ignore it)
  const known = new Set(['format', 'version', 'lang', 'packHash', 'title', 'blurb', 'chapterTitles', 'sceneTitles', 'choiceTexts', 'endings', 'characterNames', 'beats', 'puzzles'])
  for (const key of Object.keys(catalog).filter((k) => !known.has(k)).sort()) book[key] = catalog[key]

  if (problems.length > 0) fail(`the translation cannot be written:\n- ${problems.join('\n- ')}`)

  const targetKeys = new Set(flattenCatalog(book).keys())
  const sourceKeys = new Set(source.keys())
  for (const key of sourceKeys) if (!targetKeys.has(key)) fail(`the written catalog would be missing "${key}"`)
  for (const key of targetKeys) if (!sourceKeys.has(key)) fail(`the written catalog would have the unknown key "${key}"`)

  const warnings: string[] = []
  if (missing > 0) warnings.push(`${missing} of ${source.size} catalog value(s) have no translation and keep the source text`)
  if (lang === pack.book.primaryLang) warnings.push(`the target language "${lang}" is the pack's source language`)
  return { catalog: book, written: source.size - missing, missing, warnings }
}

const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')

/**
 * Writes the edition bundle: `<out>/edition.json`, the source `vn/pack.json` byte for byte, `vn/text/<lang>.json` and the bare `catalog.json`.
 * Deterministic (no timestamps, keys in pack order), and it refuses a pack that changed since the project read it, an unknown block, and any value
 * that breaks the catalog invariants.
 */
export async function writeVnPack(
  ir: DocumentIR,
  translations: ReadonlyMap<string, string>,
  srcDir: string,
  outDir: string,
  opts: WriteOptions = {}
): Promise<VnPackWriteReport> {
  const loaded = await loadVnPack(srcDir)
  const { pack, catalog: source } = loaded
  if (ir.meta.sourceHash !== undefined && !sameHash(ir.meta.sourceHash, pack.packHash)) {
    fail(`the pack changed since this project was made (packHash ${short(ir.meta.sourceHash)} -> ${short(pack.packHash)}): create a new project for the new pack`)
  }
  const lang = text(opts.targetLanguage) ?? fail('no target language code for the text catalog')
  const built = targetCatalog(pack, source, translations, lang)
  const warnings = built.warnings
  for (const message of warnings) opts.onWarning?.(message)

  const catalogPath = path.join(outDir, 'catalog.json')
  const textPath = path.join(outDir, 'vn', 'text', `${lang}.json`)
  const packPath = path.join(outDir, 'vn', 'pack.json')
  const editionPath = path.join(outDir, 'edition.json')
  await fs.mkdir(path.dirname(textPath), { recursive: true })
  await fs.writeFile(packPath, loaded.packBytes)
  const catalogBytes = jsonBytes(built.catalog)
  await fs.writeFile(textPath, catalogBytes)
  await fs.writeFile(catalogPath, catalogBytes)
  const edition = { format: VN_BUNDLE_FORMAT, version: VN_BUNDLE_VERSION, lang, packHash: pack.packHash, sourceSlug: pack.book.slug }
  await fs.writeFile(editionPath, jsonBytes(edition))

  // the template must stay byte for byte what the pack had, and its hash must still describe it
  const copied = await fs.readFile(packPath)
  if (!copied.equals(loaded.packBytes)) fail(`the copied ${PACK_REL} is not byte-identical to the source`)
  let copiedPack: unknown
  try {
    copiedPack = JSON.parse(copied.toString('utf8'))
  } catch {
    fail(`the copied ${PACK_REL} is not valid JSON`)
  }
  if (!isObject(copiedPack) || !sameHash(packHashOf(copiedPack), pack.packHash)) fail(`the copied ${PACK_REL} no longer matches its packHash`)

  return { path: outDir, catalogPath, lang, keys: flattenCatalog(built.catalog).size, warnings }
}

export const vnPackAdapter: FormatAdapter = {
  outputExt: '',
  read: (dir) => readVnPack(dir),
  write: async (ir, translations, srcDir, outDir, opts) => {
    await writeVnPack(ir, translations, srcDir, outDir, opts)
  }
}

// ---- what the translator is told about a pack (with the book brief; no prompt file) ----

const VN_PACK_NOTE_RULES = `## Visual-novel text catalog
This book is the text catalog of a visual-novel pack. Every segment is one display text that the game shows: a title, a character or alias name, a chapter or scene title, a choice, an ending, a line of narration or speech, or a puzzle clue.
Translate only the display text. The keys and the structure belong to the engine: they are not text and must never appear in a value. Never add a structural label at the start of a value (SCENE:, ON SCREEN:, NARRATION:, CG:, INSERT:, SFX:, AMBIENCE:, CLUE:, EVIDENCE:, PUZZLE:, TESTIMONY:) and never write a scene or beat id. Keep every value on one line, with no line break.
A segment that starts with a tag such as <1>PETRA (worried):</1> is spoken by that character with that expression. Copy the tag and its content unchanged and translate only the words after it, in that character's voice and with the grammatical gender of the speaker.
Keep inline emphasis (*word*, **word**) as it is.`

/** What the translator is told about a pack, with the book brief. Character names stay as the source catalog has them. */
export const VN_PACK_BRIEF_NOTE = `${VN_PACK_NOTE_RULES}
Character and alias names stay exactly as the source catalog spells them, unless the glossary gives another form; use a glossary form wherever the name appears.`

/** The same with `localizeNames`: the catalog's names are translated as any other display text, as the glossary gives them. */
export const VN_PACK_BRIEF_NOTE_LOCALIZED = `${VN_PACK_NOTE_RULES}
Character and alias names are localized: write every name as the glossary gives it, in the name values and wherever a name appears in the text.`
