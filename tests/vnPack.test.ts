import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineBus } from '../src/engine/bus'
import { CommandDispatcher } from '../src/engine/dispatcher'
import { adapterFor, briefWithNote, formatNote, formatOf, hashSource } from '../src/engine/formats'
import { classifyScriptLine, localizeScriptNames, readVnFolder, writeVnFolder } from '../src/engine/formats/vn'
import { canonicalJson, catalogValueProblem, isVnPack, packHashOf, readVnPack, writeVnPack } from '../src/engine/formats/vnPack'
import type { McpHttp } from '../src/engine/mcp/http'
import { startMcpHttp } from '../src/engine/mcp/http'
import { createMcpServer } from '../src/engine/mcp/server'
import type { ChatRequest } from '../src/engine/models/types'
import { parseGlossary } from '../src/engine/pipeline/glossary'
import { deterministicChecks } from '../src/engine/pipeline/qa'
import type { DocumentIR } from '../src/shared/ir'
import { tempDir } from './helpers'
import { asSegs, lastUser, MODEL, QA_MODEL, rig, segsIn } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

/** The canonical HUB-16 fixtures (see `fixtures/vn-pack/README.md`). */
const FIXTURES = ['soother', 'choice', 'mystery-puzzle'] as const
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures', 'vn-pack')
const fixtureDir = (name: string) => path.join(FIXTURES_DIR, name)

let r: Rig | undefined
let server: McpHttp | undefined
let client: Client | undefined
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await client?.close().catch(() => undefined)
  await server?.close()
  await r?.cleanup()
  for (const c of cleanups.splice(0)) await c()
  r = server = client = undefined
})

async function tmp(prefix = 'bt-vnp-'): Promise<string> {
  const { dir, cleanup } = await tempDir(prefix)
  cleanups.push(cleanup)
  return dir
}

/** A writable copy of a canonical fixture (a Scriptorium book folder with its pack). */
async function packCopy(name: string = 'soother'): Promise<string> {
  const dir = path.join(await tmp(), 'books')
  await fs.mkdir(dir, { recursive: true })
  const dst = path.join(dir, name)
  await fs.cp(fixtureDir(name), dst, { recursive: true })
  return dst
}

const packPath = (dir: string) => path.join(dir, 'vn', 'pack.json')
const catalogPath = (dir: string) => path.join(dir, 'vn', 'text', 'en.json')

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

const packOf = (dir: string) => readJson<PackJson>(packPath(dir))
const catalogOf = (dir: string) => readJson<CatalogJson>(catalogPath(dir))

async function editCatalog(dir: string, mutate: (catalog: CatalogJson) => void): Promise<void> {
  const catalog = await catalogOf(dir)
  mutate(catalog)
  await fs.writeFile(catalogPath(dir), JSON.stringify(catalog, null, 2) + '\n', 'utf8')
}

/** Changes the pack and the source catalog together, as Scriptorium's recompile would: the catalog carries the new packHash. */
async function recompile(dir: string, mutate: (pack: PackJson) => void): Promise<void> {
  const pack = await packOf(dir)
  mutate(pack)
  delete pack.packHash
  pack.packHash = `sha256:${packHashOf(pack as unknown as Record<string, unknown>)}`
  await fs.writeFile(packPath(dir), JSON.stringify(pack, null, 2) + '\n', 'utf8')
  const hash = pack.packHash
  await editCatalog(dir, (catalog) => {
    catalog.packHash = hash
  })
}

/** Writes the pack as it is, without recomputing its hash: a stale or hand-edited pack. */
async function writePackRaw(dir: string, mutate: (pack: PackJson) => void): Promise<void> {
  const pack = await packOf(dir)
  mutate(pack)
  await fs.writeFile(packPath(dir), JSON.stringify(pack, null, 2) + '\n', 'utf8')
}

// ---- the pack/catalog shapes the fixtures have (contract §4, §5) ----

interface BeatJson {
  id: string
  type: 'cast' | 'line' | 'narration' | 'puzzle'
  speakerKey?: string
  aliasKey?: string
  expression?: string
  puzzle?: string
}

interface SceneJson {
  id: string
  beats: BeatJson[]
}

interface ChapterJson {
  n: number
  isEnding: boolean
  choices: { index: number }[]
  scenes: SceneJson[]
}

interface CharacterJson {
  key: string
  aliasKeys?: string[]
}

interface PackJson {
  format?: string
  version?: number
  packHash?: string
  book: { slug: string; primaryLang: string; kind: string; genre?: string }
  characters: CharacterJson[]
  chapters: ChapterJson[]
  puzzles?: { key: string }[]
  expressions?: string[]
  [key: string]: unknown
}

interface CatalogJson {
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
  puzzles: Record<string, { names?: Record<string, string>; text?: Record<string, string> }>
  [extra: string]: unknown
}

const allBlocks = (ir: DocumentIR) => ir.sections.flatMap((s) => s.blocks)
const blockTexts = (ir: DocumentIR) => allBlocks(ir).map((b) => b.text)
const sortedChapters = (pack: PackJson) => [...pack.chapters].sort((a, b) => a.n - b.n)
const characterKeysOf = (pack: PackJson) => pack.characters.flatMap((c) => [c.key, ...(c.aliasKeys ?? [])])
const lineBeats = (pack: PackJson) => sortedChapters(pack).flatMap((c) => c.scenes.flatMap((s) => s.beats)).filter((b) => b.type === 'line')
const narrationBeats = (pack: PackJson) => sortedChapters(pack).flatMap((c) => c.scenes.flatMap((s) => s.beats)).filter((b) => b.type === 'narration')

/** The display name the tag of a line beat has to carry (the alias's catalog name when the beat names one). */
function lineName(pack: PackJson, catalog: CatalogJson, beat: BeatJson): string {
  return catalog.characterNames[beat.aliasKey ?? beat.speakerKey!] ?? catalog.characterNames[beat.speakerKey!]!
}

function speakerTag(name: string, expression?: string): string {
  const expr = expression?.trim()
  return `<1>${expr && expr.toLowerCase() !== 'neutral' ? `${name} (${expr})` : name}:</1>`
}

/** The catalog paths of a catalog, as block ids (an independent flattening, to cross-check the adapter). */
function flattened(catalog: CatalogJson): Map<string, string> {
  const out = new Map<string, string>()
  out.set('title', catalog.title)
  if (catalog.blurb !== undefined) out.set('blurb', catalog.blurb)
  for (const [n, value] of Object.entries(catalog.chapterTitles)) out.set(`chapter.${Number(n)}.title`, value)
  for (const [id, value] of Object.entries(catalog.sceneTitles ?? {})) out.set(`scene.${id}`, value)
  for (const [key, value] of Object.entries(catalog.choiceTexts)) {
    const [n, i] = key.split(':')
    out.set(`choice.${Number(n)}.${Number(i)}`, value)
  }
  for (const [n, value] of Object.entries(catalog.endings)) out.set(`ending.${Number(n)}`, value)
  for (const [key, value] of Object.entries(catalog.characterNames)) out.set(`char.${key}`, value)
  for (const [id, value] of Object.entries(catalog.beats)) out.set(`beat.${id}`, value)
  for (const [puzzle, entry] of Object.entries(catalog.puzzles ?? {})) {
    for (const [id, value] of Object.entries(entry.names ?? {})) out.set(`puzzle.${puzzle}.name.${id}`, value)
    for (const [id, value] of Object.entries(entry.text ?? {})) out.set(`puzzle.${puzzle}.text.${id}`, value)
  }
  return out
}

function puzzleBlockIds(pack: PackJson, puzzles: Record<string, { names?: Record<string, string>; text?: Record<string, string> }>): string[] {
  const ids: string[] = []
  for (const puzzle of pack.puzzles ?? []) {
    const entry = puzzles[puzzle.key]
    if (!entry) continue
    for (const id of Object.keys(entry.names ?? {}).sort()) ids.push(`puzzle.${puzzle.key}.name.${id}`)
    for (const id of Object.keys(entry.text ?? {}).sort()) ids.push(`puzzle.${puzzle.key}.text.${id}`)
  }
  return ids
}

/** The block ids in the adapter's order, derived from the pack and the catalog (the contract's keys, not the adapter's code). */
function expectedBlockIds(pack: PackJson, catalog: CatalogJson): string[] {
  const ids = ['title']
  if (catalog.blurb !== undefined) ids.push('blurb')
  for (const key of characterKeysOf(pack)) ids.push(`char.${key}`)
  for (const chapter of sortedChapters(pack)) {
    ids.push(`chapter.${chapter.n}.title`)
    for (const scene of chapter.scenes) {
      if (catalog.sceneTitles?.[scene.id] !== undefined) ids.push(`scene.${scene.id}`)
      for (const beat of scene.beats) if (beat.type === 'line' || beat.type === 'narration') ids.push(`beat.${beat.id}`)
    }
    for (const choice of chapter.choices) ids.push(`choice.${chapter.n}.${choice.index}`)
    if (chapter.isEnding) ids.push(`ending.${chapter.n}`)
  }
  ids.push(...puzzleBlockIds(pack, catalog.puzzles ?? {}))
  return ids
}

function expectedSectionTitles(pack: PackJson, catalog: CatalogJson): string[] {
  const titles = ['Book']
  if (characterKeysOf(pack).length > 0) titles.push('Characters')
  for (const chapter of sortedChapters(pack)) titles.push(`Chapter ${chapter.n}`)
  if (puzzleBlockIds(pack, catalog.puzzles ?? {}).length > 0) titles.push('Puzzles')
  return titles
}

/** A model-like catalog translation: keeps a leading speaker tag and marks the words. */
const translate = (text: string) => text.replace(/^(<1>[\s\S]*?<\/1>\s*)?([\s\S]*)$/, (_m, tag: string | undefined, rest: string) => `${tag ?? ''}[hr] ${rest}`)

function translationsFor(ir: DocumentIR): Map<string, string> {
  const map = new Map<string, string>()
  for (const b of allBlocks(ir)) map.set(b.id, translate(b.text))
  return map
}

describe('visual-novel pack: detection and source identity', () => {
  it('is picked before the legacy book folder for every canonical fixture, and a folder without the pack falls back to vn', async () => {
    for (const name of FIXTURES) {
      const dir = fixtureDir(name)
      expect(isVnPack(dir), name).toBe(true)
      expect(formatOf(dir), name).toBe('vnp')
      expect(adapterFor(dir).outputExt, name).toBe('')
      // the fixture also has book.md and chapters/: the pack wins
      expect((await fs.stat(path.join(dir, 'book.md'))).isFile(), name).toBe(true)
      expect((await fs.stat(path.join(dir, 'chapters'))).isDirectory(), name).toBe(true)
    }
    // the same book folder without vn/ is the legacy format
    const legacy = path.join(await tmp(), 'soother')
    await fs.cp(fixtureDir('soother'), legacy, { recursive: true })
    await fs.rm(path.join(legacy, 'vn'), { recursive: true })
    expect(isVnPack(legacy)).toBe(false)
    expect(formatOf(legacy)).toBe('vn')
  })

  it('hashes the template and the source catalog only: the authored files and other editions never start a new project', async () => {
    for (const name of FIXTURES) {
      const dir = await packCopy(name)
      const before = await hashSource(dir)
      expect(before, name).toMatch(/^[0-9a-f]{64}$/)
      expect(await hashSource(dir), name).toBe(before)
      // authored files are not part of it
      await fs.writeFile(path.join(dir, 'book.md'), '---\ntitle: rewritten\n---\n', 'utf8')
      await fs.writeFile(path.join(dir, 'outline.md'), '---\nkind: outline\n---\n', 'utf8')
      await fs.writeFile(path.join(dir, 'chapters', 'ch-02.md'), 'SCENE: elsewhere\n', 'utf8')
      // and neither is another language's edition
      await fs.writeFile(path.join(dir, 'vn', 'text', 'hr.json'), '{"format":"vn-text","version":2,"lang":"hr"}', 'utf8')
      expect(await hashSource(dir), name).toBe(before)
      // the source catalog and the template are
      await editCatalog(dir, (catalog) => {
        catalog.title = `${catalog.title} (edited)`
      })
      expect(await hashSource(dir), name).not.toBe(before)
    }
    const dir = await packCopy('soother')
    const before = await hashSource(dir)
    await writePackRaw(dir, (pack) => {
      pack.book.genre = 'Horror'
    })
    expect(await hashSource(dir)).not.toBe(before)
  })

  it('holds the packHash to the canonical JSON, and refuses a template changed after its hash was written', async () => {
    for (const name of FIXTURES) {
      const pack = await packOf(fixtureDir(name))
      expect(pack.packHash, name).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(packHashOf(pack as unknown as Record<string, unknown>), name).toBe(String(pack.packHash).replace(/^sha256:/, ''))
      expect(pack.expressions, name).toBeUndefined() // the contract: expressions are optional and Scriptorium omits them
    }
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}')
    const dir = await packCopy('soother')
    await writePackRaw(dir, (pack) => {
      pack.book.genre = 'Horror'
    })
    await expect(readVnPack(dir)).rejects.toThrow(/packHash .* does not match its content/)
  })

  it('tells the agents the v2 catalog rules and the localized-name variant, and nothing about a whole folder', () => {
    expect(formatNote('vnp')).toContain('Visual-novel text catalog')
    expect(formatNote('vnp')).toContain('Never add a structural label')
    expect(formatNote('vnp')).toContain('Keep every value on one line')
    expect(formatNote('vnp')).not.toContain('Character and alias names are localized')
    expect(formatNote('vnp', { localizeNames: true })).toContain('Character and alias names are localized')
    expect(briefWithNote('Genre: mystery', 'vnp')).toContain('Genre: mystery\n\n## Visual-novel text catalog')
  })
})

describe('visual-novel pack: the IR', () => {
  it('has one block per catalog key for every fixture, in pack order and in the contract sections', async () => {
    for (const name of FIXTURES) {
      const dir = fixtureDir(name)
      const pack = await packOf(dir)
      const catalog = await catalogOf(dir)
      const ir = await readVnPack(dir)
      expect(ir.format, name).toBe('vnp')
      expect(ir.meta.title, name).toBe(catalog.title)
      expect(ir.meta.language, name).toBe(pack.book.primaryLang)
      expect(ir.meta.sourceHash, name).toBe(pack.packHash)
      const names: string[] = []
      for (const key of characterKeysOf(pack)) {
        const display = catalog.characterNames[key]?.trim()
        if (display && !names.includes(display)) names.push(display)
      }
      expect(ir.meta.names, name).toEqual(names)
      expect(ir.sections.map((s) => s.title), name).toEqual(expectedSectionTitles(pack, catalog))
      const blocks = allBlocks(ir)
      expect(blocks.map((b) => b.id), name).toEqual(expectedBlockIds(pack, catalog))
      expect(new Set(blocks.map((b) => b.id)).size, name).toBe(blocks.length)
      // the keys the adapter made are exactly the catalog's own keys
      expect(blocks.map((b) => b.id).sort(), name).toEqual([...flattened(catalog).keys()].sort())
    }
  })

  it('maps values, kinds and the speaker context of line beats (the alias name when a beat names one)', async () => {
    for (const name of FIXTURES) {
      const dir = fixtureDir(name)
      const pack = await packOf(dir)
      const catalog = await catalogOf(dir)
      const ir = await readVnPack(dir)
      const byId = new Map(allBlocks(ir).map((b) => [b.id, b]))
      expect(byId.get('title'), name).toMatchObject({ kind: 'heading', text: catalog.title })
      if (catalog.blurb !== undefined) expect(byId.get('blurb'), name).toMatchObject({ text: catalog.blurb })
      else expect(byId.has('blurb'), name).toBe(false)
      for (const key of characterKeysOf(pack)) expect(byId.get(`char.${key}`), name).toMatchObject({ text: catalog.characterNames[key] })
      for (const chapter of sortedChapters(pack)) {
        expect(byId.get(`chapter.${chapter.n}.title`), name).toMatchObject({ kind: 'heading', text: catalog.chapterTitles[String(chapter.n)] })
        for (const scene of chapter.scenes) {
          if (catalog.sceneTitles?.[scene.id] !== undefined) expect(byId.get(`scene.${scene.id}`), name).toMatchObject({ text: catalog.sceneTitles[scene.id] })
          for (const beat of scene.beats) {
            if (beat.type === 'puzzle' || beat.type === 'cast') {
              expect(byId.has(`beat.${beat.id}`), `${name} ${beat.id}`).toBe(false)
            }
          }
        }
        for (const choice of chapter.choices) {
          expect(byId.get(`choice.${chapter.n}.${choice.index}`), name).toMatchObject({ kind: 'item', text: catalog.choiceTexts[`${chapter.n}:${choice.index}`] })
        }
        if (chapter.isEnding) expect(byId.get(`ending.${chapter.n}`), name).toMatchObject({ text: catalog.endings[String(chapter.n)] })
      }
      for (const beat of lineBeats(pack)) {
        const block = byId.get(`beat.${beat.id}`)!
        expect(block.tags, `${name} ${beat.id}`).toEqual([{ n: 1, kind: 'pair', data: 'speaker' }])
        expect(block.text, `${name} ${beat.id}`).toBe(`${speakerTag(lineName(pack, catalog, beat), beat.expression)} ${catalog.beats[beat.id]}`)
      }
      for (const beat of narrationBeats(pack)) {
        expect(byId.get(`beat.${beat.id}`), `${name} ${beat.id}`).toMatchObject({ text: catalog.beats[beat.id], tags: [] })
      }
      for (const puzzle of pack.puzzles ?? []) {
        const entry = catalog.puzzles[puzzle.key]!
        for (const [id, value] of Object.entries(entry.names ?? {})) expect(byId.get(`puzzle.${puzzle.key}.name.${id}`), `${name} ${puzzle.key}`).toMatchObject({ kind: 'item', text: value })
        for (const [id, value] of Object.entries(entry.text ?? {})) expect(byId.get(`puzzle.${puzzle.key}.text.${id}`), `${name} ${puzzle.key}`).toMatchObject({ text: value })
      }
    }
  })

  it('never puts keys, structure, asset ids or UI strings into a value', async () => {
    for (const name of FIXTURES) {
      const ir = await readVnPack(fixtureDir(name))
      for (const b of allBlocks(ir)) {
        expect(b.text, `${name} ${b.id}`).not.toMatch(/\bch\d{2}\.s\d{2}\b/)
        expect(b.text, `${name} ${b.id}`).not.toMatch(/\b(chapter|choice|ending|beat|puzzle)\.\d/)
        expect(b.text, `${name} ${b.id}`).not.toMatch(/(?:cg|sfx|amb|background|sprite|insert)_\w/)
        expect(b.text, `${name} ${b.id}`).not.toMatch(/vn\/(?:pack|text)/)
        if (!/^<1>[\s\S]*?<\/1>/.test(b.text)) expect(b.text, `${name} ${b.id}`).not.toMatch(/<\/?\d+\/?>/)
        else expect(b.id, `${name} ${b.id}`).toMatch(/^beat\./)
      }
      // the fixture families cover the contract's interesting shapes
      const pack = await packOf(fixtureDir(name))
      if (name === 'soother') {
        expect(pack.characters.some((c) => (c.aliasKeys ?? []).length > 0)).toBe(true)
        expect(pack.puzzles ?? []).toEqual([])
      }
      if (name === 'choice') {
        expect(sortedChapters(pack).some((c) => c.isEnding)).toBe(true)
        expect(sortedChapters(pack).some((c) => c.choices.length > 0)).toBe(true)
      }
      if (name === 'mystery-puzzle') expect((pack.puzzles ?? []).length).toBeGreaterThan(0)
    }
  })
})

describe('visual-novel pack: export', () => {
  it('writes the bundle for every fixture with a byte-identical template and an exactly matching key set', async () => {
    for (const name of FIXTURES) {
      const dir = fixtureDir(name)
      const pack = await packOf(dir)
      const ir = await readVnPack(dir)
      const out = path.join(await tmp(), name, `${pack.book.slug}.hr`)
      const warnings: string[] = []
      const report = await writeVnPack(ir, translationsFor(ir), dir, out, { targetLanguage: 'hr', onWarning: (m) => warnings.push(m) })
      expect(warnings, name).toEqual([])
      expect(report, name).toMatchObject({ path: out, lang: 'hr', keys: allBlocks(ir).length, warnings: [] })
      expect(report.catalogPath, name).toBe(path.join(out, 'catalog.json'))

      // the template is byte-identical and its hash still describes it
      expect(await fs.readFile(path.join(out, 'vn', 'pack.json')), name).toEqual(await fs.readFile(path.join(dir, 'vn', 'pack.json')))
      expect(await fs.readFile(path.join(dir, 'vn', 'pack.json')), name).toEqual(await fs.readFile(path.join(fixtureDir(name), 'vn', 'pack.json')))
      const writtenPack = await readJson<PackJson>(path.join(out, 'vn', 'pack.json'))
      expect(packHashOf(writtenPack as unknown as Record<string, unknown>), name).toBe(String(pack.packHash).replace(/^sha256:/, ''))

      expect(await readJson(path.join(out, 'edition.json')), name).toEqual({ format: 'vn-edition-bundle', version: 2, lang: 'hr', packHash: pack.packHash, sourceSlug: pack.book.slug })
      const textCatalog = await fs.readFile(path.join(out, 'vn', 'text', 'hr.json'))
      expect(await fs.readFile(report.catalogPath), name).toEqual(textCatalog)
      const catalog = JSON.parse(textCatalog.toString('utf8')) as CatalogJson
      expect(catalog, name).toMatchObject({ format: 'vn-text', version: 2, lang: 'hr', packHash: pack.packHash })
      // key parity, every value translated, one line, no structural label or id
      const source = await catalogOf(dir)
      expect([...flattened(catalog).keys()].sort(), name).toEqual([...flattened(source).keys()].sort())
      for (const [key, value] of flattened(catalog)) {
        expect(catalogValueProblem(value), `${name} ${key}`).toBeUndefined()
        expect(value.startsWith('[hr] '), `${name} ${key}`).toBe(true)
      }
      // the speaker tag is context for the translator only: it is not part of the catalog value
      for (const beat of lineBeats(pack)) {
        expect(catalog.beats[beat.id], `${name} ${beat.id}`).toBe(`[hr] ${source.beats[beat.id]}`)
        expect(catalog.beats[beat.id], `${name} ${beat.id}`).not.toContain('<1>')
      }
      // the source is untouched
      expect(await packOf(dir), name).toEqual(pack)
    }
  })

  it('is deterministic and carries unknown catalog metadata through', async () => {
    const dir = await packCopy('soother')
    await editCatalog(dir, (catalog) => {
      catalog.origin = { tool: 'test', kept: true }
    })
    const ir = await readVnPack(dir)
    const outA = path.join(await tmp(), 'a', 'bundle')
    const outB = path.join(await tmp(), 'b', 'bundle')
    await writeVnPack(ir, translationsFor(ir), dir, outA, { targetLanguage: 'hr' })
    await writeVnPack(ir, translationsFor(ir), dir, outB, { targetLanguage: 'hr' })
    for (const rel of ['edition.json', 'vn/pack.json', 'vn/text/hr.json', 'catalog.json']) {
      expect(await fs.readFile(path.join(outA, rel)), rel).toEqual(await fs.readFile(path.join(outB, rel)))
    }
    expect((await readJson<CatalogJson>(path.join(outA, 'catalog.json'))).origin).toEqual({ tool: 'test', kept: true })
  })

  it('exports partial progress with a warning, keeping the source text of untranslated values', async () => {
    const dir = await packCopy('soother')
    const ir = await readVnPack(dir)
    const catalog = await catalogOf(dir)
    const partial = new Map<string, string>([['title', 'Pisma iz svjetionika']])
    const out = path.join(await tmp(), 'partial')
    const warnings: string[] = []
    const report = await writeVnPack(ir, partial, dir, out, { targetLanguage: 'hr', onWarning: (m) => warnings.push(m) })
    expect(warnings.join('\n')).toMatch(/no translation and keep the source text/)
    expect(report.warnings).toEqual(warnings)
    const written = await readJson<CatalogJson>(path.join(out, 'catalog.json'))
    expect(written.title).toBe('Pisma iz svjetionika')
    expect(written.beats[Object.keys(catalog.beats)[0]!]).toBe(catalog.beats[Object.keys(catalog.beats)[0]!])
    const same = path.join(await tmp(), 'same')
    const w2: string[] = []
    await writeVnPack(ir, translationsFor(ir), dir, same, { targetLanguage: 'en', onWarning: (m) => w2.push(m) })
    expect(w2.join('\n')).toMatch(/is the pack's source language/)
  })

  it('refuses a translation that breaks the catalog contract, or a block the pack does not have', async () => {
    const dir = await packCopy('soother')
    const ir = await readVnPack(dir)
    const good = translationsFor(ir)
    const line = lineBeats(await packOf(dir))[0]!
    const narration = narrationBeats(await packOf(dir))[0]!
    const cases: [string, string, RegExp][] = [
      ['title', 'Line one\nLine two', /more than one line/],
      ['title', '   ', /is empty/],
      ['title', 'SCENE: The Late Boat', /structural label "SCENE:"/],
      ['title', '**ON SCREEN:** everyone', /structural label "ON SCREEN:"/],
      ['blurb', 'see ch01.s01.b002', /scene or beat id/],
      [`beat.${narration.id}`, 'x <2/> y', /contains an inline placeholder tag/],
      [`beat.${line.id}`, '</1> only a closing tag', /inline tags that do not match the source/],
      [`beat.${line.id}`, '<1>Petra (grumpy):</1>', /is empty/]
    ]
    for (const [key, value, message] of cases) {
      const tr = new Map(good)
      tr.set(key, value)
      await expect(writeVnPack(ir, tr, dir, path.join(await tmp(), 'bad'), { targetLanguage: 'hr' }), `${key}: ${value}`).rejects.toThrow(message)
    }
    const extra = new Map(good)
    extra.set('beat.ch99.s99.b999', 'x')
    await expect(writeVnPack(ir, extra, dir, path.join(await tmp(), 'extra'), { targetLanguage: 'hr' })).rejects.toThrow(/unknown block "beat\.ch99\.s99\.b999"/)
  })

  it('refuses a pack that changed since the project read it', async () => {
    const dir = await packCopy('soother')
    const ir = await readVnPack(dir)
    await recompile(dir, (pack) => {
      pack.book.slug = `${pack.book.slug}-2`
    })
    await expect(writeVnPack(ir, translationsFor(ir), dir, path.join(await tmp(), 'changed'), { targetLanguage: 'hr' })).rejects.toThrow(/the pack changed since this project was made/)
  })

  it('rejects a source catalog that is missing a key, has an extra one or breaks a value rule', async () => {
    const missing = await packCopy('soother')
    await editCatalog(missing, (catalog) => {
      delete (catalog as unknown as Record<string, unknown>).title
    })
    await expect(readVnPack(missing)).rejects.toThrow(/title is not a string/)

    const extra = await packCopy('soother')
    await editCatalog(extra, (catalog) => {
      catalog.chapterTitles['99'] = 'A chapter that does not exist'
    })
    await expect(readVnPack(extra)).rejects.toThrow(/chapterTitles has the unknown key "99"/)

    const noBeat = await packCopy('soother')
    const beat = (await packOf(noBeat)).chapters[0]!.scenes.flatMap((s) => s.beats).find((b) => b.type === 'narration')!
    await editCatalog(noBeat, (catalog) => {
      delete catalog.beats[beat.id]
    })
    await expect(readVnPack(noBeat)).rejects.toThrow(new RegExp(`beats is missing "${beat.id.replace(/[.]/g, '\\.')}"`))

    const extraName = await packCopy('soother')
    await editCatalog(extraName, (catalog) => {
      catalog.characterNames.ghost = 'Ghost'
    })
    await expect(readVnPack(extraName)).rejects.toThrow(/characterNames has the unknown key "ghost"/)

    const multi = await packCopy('soother')
    await editCatalog(multi, (catalog) => {
      catalog.blurb = 'One line\nand another'
    })
    await expect(readVnPack(multi)).rejects.toThrow(/blurb is more than one line/)

    const label = await packCopy('soother')
    await editCatalog(label, (catalog) => {
      catalog.title = 'NARRATION: The Soother'
    })
    await expect(readVnPack(label)).rejects.toThrow(/title begins with the structural label "NARRATION:"/)
  })

  it('rejects a pack or catalog from another version, language or pack', async () => {
    const version = await packCopy('soother')
    await writePackRaw(version, (pack) => {
      pack.version = 1
    })
    await expect(readVnPack(version)).rejects.toThrow(/version is 1/)

    const format = await packCopy('soother')
    await writePackRaw(format, (pack) => {
      pack.format = 'something-else'
    })
    await expect(readVnPack(format)).rejects.toThrow(/format is "something-else"/)

    const lang = await packCopy('soother')
    await editCatalog(lang, (catalog) => {
      catalog.lang = 'hr'
    })
    await expect(readVnPack(lang)).rejects.toThrow(/text catalog is for "hr"/)

    const hash = await packCopy('soother')
    await editCatalog(hash, (catalog) => {
      catalog.packHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    })
    await expect(readVnPack(hash)).rejects.toThrow(/belongs to pack/)

    const noText = await packCopy('soother')
    await fs.rm(catalogPath(noText))
    await expect(readVnPack(noText)).rejects.toThrow(/source catalog vn\/text\/en\.json is missing/)
  })

  it('reads an optional line aliasKey: it only changes the name tag, never the catalog keys', async () => {
    const dir = await packCopy('soother')
    const pack = await packOf(dir)
    const catalog = await catalogOf(dir)
    const beat = lineBeats(pack)[0]!
    const speaker = pack.characters.find((c) => c.key === beat.speakerKey)!
    const alias = speaker.aliasKeys?.[0]
    expect(alias, 'the soother fixture has an alias').toBeTruthy()
    const before = await readVnPack(dir)
    await recompile(dir, (changed) => {
      for (const c of changed.chapters) for (const s of c.scenes) for (const b of s.beats) if (b.id === beat.id) b.aliasKey = alias
    })
    const ir = await readVnPack(dir)
    expect(allBlocks(ir).map((b) => b.id)).toEqual(allBlocks(before).map((b) => b.id))
    const block = allBlocks(ir).find((b) => b.id === `beat.${beat.id}`)!
    expect(block.text.startsWith(speakerTag(catalog.characterNames[alias!]!, beat.expression))).toBe(true)
    // an alias the pack does not have is refused
    await recompile(dir, (changed) => {
      for (const c of changed.chapters) for (const s of c.scenes) for (const b of s.beats) if (b.id === beat.id) b.aliasKey = 'ghost#1'
    })
    await expect(readVnPack(dir)).rejects.toThrow(/alias "ghost#1"/)
  })
})

describe('visual-novel pack: deterministic QA', () => {
  it('checks catalog values and leaves name blocks out of the untranslated check', () => {
    const segs = [
      { id: 'char.petra#1', blockId: 'char.petra#1', text: "the keeper's girl" },
      { id: 'beat.ch01.s01.b002', blockId: 'beat.ch01.s01.b002', text: 'Rain needles the grey water.' },
      { id: 'beat.ch01.s01.b003', blockId: 'beat.ch01.s01.b003', text: '<1>Petra (worried):</1> He said he would be back.' }
    ]
    const final: Record<string, string> = {
      'char.petra#1': "the keeper's girl",
      'beat.ch01.s01.b002': 'Kiša pada na sivo more.',
      'beat.ch01.s01.b003': 'SCENE: He said he would be back.'
    }
    const issues = deterministicChecks(segs, final, [], { format: 'vnp' })
    // a name kept as it is (an alias longer than three words too) is not "left untranslated"
    expect(issues.some((i) => i.segId === 'char.petra#1' && i.type === 'untranslated')).toBe(false)
    expect(issues.some((i) => i.segId === 'beat.ch01.s01.b003' && i.type === 'mistranslation' && /structural label/.test(i.comment))).toBe(true)
  })

  it('adds the pack checks only for the vnp format', () => {
    const segs = [{ id: 'b1', blockId: 'b1', text: 'Rain needles the grey water.' }]
    const final = { b1: 'SCENE: rain needles the grey water.' }
    expect(deterministicChecks(segs, final, [], {}).filter((i) => i.type === 'mistranslation')).toEqual([])
    expect(deterministicChecks(segs, final, [], { format: 'vnp' }).some((i) => i.type === 'mistranslation')).toBe(true)
  })
})

describe('visual-novel pack: through the engine (mock models)', () => {
  async function pipelineProject(name = 'soother', localizeNames = false): Promise<{ p: Awaited<ReturnType<Rig['service']['createProject']>>; book: string; pack: PackJson; catalog: CatalogJson; seen: { system: string; glossary: string; segments: { id: string; text: string }[] } }> {
    r = await rig()
    const book = path.join(r.dir, 'books', name)
    await fs.cp(fixtureDir(name), book, { recursive: true })
    const pack = await packOf(book)
    const catalog = await catalogOf(book)
    const seen = { system: '', glossary: '', segments: [] as { id: string; text: string }[] }
    r.mock.on({ role: 'glossary' }, (req: ChatRequest) => {
      seen.glossary += req.messages.map((m) => m.content).join('\n')
      return JSON.stringify({ terms: [{ source: 'Petra', target: 'Petra', type: 'person', gender: 'f' }], brief: { genre: 'fiction', tone: 'light', characters: [] } })
    })
    r.mock.on({ role: 'translator' }, (req: ChatRequest) => {
      seen.system = req.messages[0]!.content
      seen.segments.push(...segsIn(lastUser(req)))
      return asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: translate(s.text) })))
    })
    r.mock.on({ role: 'qa' }, '{"issues":[]}')
    const p = await r.service.createProject({
      sourcePath: book,
      targetLanguage: 'Croatian',
      sourceLanguage: 'English',
      settings: {
        agentModels: { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] },
        enabled: { glossary: localizeNames, proofreader: false, qa: true },
        maxChunkTokens: 200,
        localizeNames
      }
    })
    return { p, book, pack, catalog, seen }
  }

  it('creates the project for the pack (not the folder), runs to done and exports a bundle with key parity', async () => {
    const { p, book, pack, catalog, seen } = await pipelineProject('soother')
    expect(p.format).toBe('vnp')
    expect(p.name).toBe(catalog.title)
    expect(p.id).toMatch(/^soother-hr-[0-9a-f]{6}$/)
    // the same pack and language give the same project; another language's catalog does not change it
    await fs.writeFile(path.join(book, 'vn', 'text', 'de.json'), '{"format":"vn-text","version":2,"lang":"de"}', 'utf8')
    expect((await r!.service.createProject({ sourcePath: book, targetLanguage: 'Croatian' })).id).toBe(p.id)

    const res = await r!.service.start(p.id)
    expect(res.status).toBe('done')
    expect(seen.system).toContain('Visual-novel text catalog')
    expect(seen.system).toContain('Never add a structural label')
    // keys and structure reach the model only as the <seg id> wrapper, never as text; a line beat carries its speaker tag
    expect(seen.segments.length).toBeGreaterThanOrEqual(allBlocks(await readVnPack(book)).length)
    for (const s of seen.segments) {
      expect(s.text, s.id).not.toMatch(/ch\d{2}\.s\d{2}/)
      expect(s.text, s.id).not.toMatch(/char\.|chapter\.|choice\.|ending\.|puzzle\.|petra#/)
      expect(s.text, s.id).not.toMatch(/(?:cg|sfx|amb|background|sprite)_\w/)
    }
    for (const beat of lineBeats(pack)) expect(seen.segments.find((s) => s.id === `beat.${beat.id}`)!.text).toBe(`${speakerTag(lineName(pack, catalog, beat), beat.expression)} ${catalog.beats[beat.id]}`)
    for (const beat of narrationBeats(pack)) expect(seen.segments.find((s) => s.id === `beat.${beat.id}`)!.text).not.toContain('<1>')
    // names are kept by default: the glossary has a keep row for each character and alias name
    const glossary = parseGlossary(await fs.readFile(r!.service.store.file(p.id, 'glossary.md'), 'utf8'))
    for (const key of characterKeysOf(pack)) expect(glossary.find((e) => e.source === catalog.characterNames[key])).toMatchObject({ target: catalog.characterNames[key], type: 'person' })

    const report = await r!.service.exportWithReport(p.id)
    expect(report).toMatchObject({ lang: 'hr', keys: allBlocks(await readVnPack(book)).length })
    expect(path.basename(report.path)).toBe(`${pack.book.slug}.hr`)
    expect(await fs.readFile(path.join(report.path, 'vn', 'pack.json'))).toEqual(await fs.readFile(path.join(book, 'vn', 'pack.json')))
    const written = await readJson<CatalogJson>(path.join(report.path, 'vn', 'text', 'hr.json'))
    expect(written.title).toBe(`[hr] ${catalog.title}`)
    expect([...flattened(written).keys()].sort()).toEqual([...flattened(catalog).keys()].sort())
    for (const [key, value] of flattened(written)) expect(value.startsWith('[hr] '), key).toBe(true)
    // the second export is identical
    const again = await r!.service.exportWithReport(p.id)
    expect(await fs.readFile(path.join(again.path, 'catalog.json'))).toEqual(await fs.readFile(path.join(report.path, 'catalog.json')))
  })

  it('covers the puzzle and choice fixtures too: every catalog value is one segment, puzzle prose included', async () => {
    for (const name of ['choice', 'mystery-puzzle'] as const) {
      const { p, pack, catalog, seen } = await pipelineProject(name)
      expect((await r!.service.start(p.id)).status).toBe('done')
      const ids = new Set(seen.segments.map((s) => s.id))
      for (const key of characterKeysOf(pack)) expect(ids.has(`char.${key}`), `${name} ${key}`).toBe(true)
      for (const chapter of sortedChapters(pack)) for (const choice of chapter.choices) expect(ids.has(`choice.${chapter.n}.${choice.index}`), name).toBe(true)
      for (const puzzle of pack.puzzles ?? []) for (const id of Object.keys(catalog.puzzles[puzzle.key]!.text ?? {})) expect(ids.has(`puzzle.${puzzle.key}.text.${id}`), `${name} ${puzzle.key}`).toBe(true)
      const report = await r!.service.exportWithReport(p.id)
      const written = await readJson<CatalogJson>(path.join(report.path, 'catalog.json'))
      expect([...flattened(written).keys()].sort(), name).toEqual([...flattened(catalog).keys()].sort())
      await r!.cleanup()
      r = undefined
    }
  })

  it('starts a new project when the pack changes', async () => {
    const { p, book } = await pipelineProject('soother')
    await recompile(book, (pack) => {
      pack.book.genre = 'Horror'
    })
    const other = await r!.service.createProject({ sourcePath: book, targetLanguage: 'Croatian', sourceLanguage: 'English' })
    expect(other.id).not.toBe(p.id)
    await expect(r!.service.exportWithReport(p.id)).rejects.toThrow(/the pack changed since this project was made/)
  })

  it('asks the glossary for the catalog names with localizeNames', async () => {
    const { p, pack, catalog, seen } = await pipelineProject('soother', true)
    expect((await r!.service.start(p.id)).status).toBe('done')
    expect(seen.glossary).toContain('localized for Croatian readers')
    expect(seen.glossary).toContain([...new Set(characterKeysOf(pack).map((k) => catalog.characterNames[k]))].join(', '))
    expect(seen.system).toContain('Character and alias names are localized')
  })
})

describe('visual-novel pack: MCP', () => {
  const TOKEN = 'test-token'
  const MODELS = { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] }
  const NO_AGENTS = { glossary: false, proofreader: false, qa: false }

  async function setup(name = 'mystery-puzzle') {
    const bus = new EngineBus()
    r = await rig({ onEvent: (e) => bus.emit(e) })
    const dispatcher = new CommandDispatcher({ service: r.service, emit: (e) => bus.emit(e), showMock: true, keys: () => undefined, storeKey: () => undefined })
    server = await startMcpHttp({ port: 0, token: TOKEN, factory: () => createMcpServer(dispatcher, r!.service, bus) })
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
    client = c
    const book = path.join(r.dir, 'books', name)
    await fs.cp(fixtureDir(name), book, { recursive: true })
    return { c, book, name }
  }

  type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }
  async function call<T = unknown>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = (await c.callTool({ name, arguments: args })) as ToolResult
    const t = res.content[0]!.text
    if (res.isError) throw new Error(t)
    try {
      return JSON.parse(t) as T
    } catch {
      return t as T
    }
  }

  it('analyzes the pack folder, creates the project, translates it with the translator path and exports the bundle', async () => {
    const { c, book } = await setup('mystery-puzzle')
    const pack = await packOf(book)
    const catalog = await catalogOf(book)
    const info = await call<{ file: { format: string; outputExt: string; title?: string } }>(c, 'analyze_file', { sourcePath: book, targetLanguage: 'Croatian' })
    expect(info.file.format).toBe('vnp')
    expect(info.file.outputExt).toBe('')
    expect(info.file.title).toBe(catalog.title)

    const p = await call<{ id: string; format: string; name: string }>(c, 'create_project', { sourcePath: book, targetLanguage: 'Croatian', sourceLanguage: 'English', agentModels: { translator: [] }, enabledAgents: NO_AGENTS, maxChunkTokens: 200 })
    expect(p.format).toBe('vnp')
    expect(p.name).toBe(catalog.title)
    const prepared = await call<{ chunks: number }>(c, 'prepare_chunks', { projectId: p.id })
    expect(prepared.chunks).toBeGreaterThan(0)
    for (let i = 0; i < prepared.chunks + 2; i++) {
      const task = (await c.callTool({ name: 'get_translation_task', arguments: { projectId: p.id } })) as ToolResult
      if (task.isError) {
        expect(task.content[0]!.text).toMatch(/nothing left/)
        break
      }
      const meta = JSON.parse(task.content[0]!.text) as { done?: boolean; index?: number }
      if (meta.done) break
      expect(task.content[1]!.text).toContain('Visual-novel text catalog')
      const segs = segsIn(task.content[2]!.text)
      const reply = segs.map((s) => `<seg id="${s.id}">${translate(s.text)}</seg>`).join('\n')
      const ok = await call<{ ok: boolean; problems?: string[] }>(c, 'submit_translation', { projectId: p.id, index: meta.index, reply })
      expect(ok.ok, (ok.problems ?? []).join(' ')).toBe(true)
    }
    expect((await call<{ project: { status: string } }>(c, 'get_project', { projectId: p.id })).project.status).toBe('done')

    const out = await call<{ path: string; catalog: string; lang: string; keys: number; warnings: string[] }>(c, 'export_project', { projectId: p.id })
    expect(out.lang).toBe('hr')
    expect(out.keys).toBe(allBlocks(await readVnPack(book)).length)
    expect(path.basename(out.path)).toBe(`${pack.book.slug}.hr`)
    const written = await readJson<CatalogJson>(out.catalog)
    expect([...flattened(written).keys()].sort()).toEqual([...flattened(catalog).keys()].sort())
    expect(written.puzzles.dinner!.text!.murder).toBe(`[hr] ${catalog.puzzles.dinner!.text!.murder}`)
    expect(r!.mock.calls.filter((x) => x.meta?.role === 'translator')).toHaveLength(0)
    expect(await fs.readFile(path.join(out.path, 'vn', 'pack.json'))).toEqual(await fs.readFile(path.join(book, 'vn', 'pack.json')))
  })

  it('runs the model path too: create, start, wait and export', async () => {
    const { c, book } = await setup('choice')
    const pack = await packOf(book)
    const p = await call<{ id: string; format: string }>(c, 'create_project', { sourcePath: book, targetLanguage: 'hr', sourceLanguage: 'English', agentModels: MODELS, enabledAgents: NO_AGENTS, maxChunkTokens: 200 })
    expect(p.format).toBe('vnp')
    expect(await call(c, 'start_translation', { projectId: p.id })).toMatchObject({ started: true })
    let last: { status: string; running: boolean } | undefined
    for (let i = 0; i < 60; i++) {
      const next = await call<{ status: string; running: boolean }>(c, 'wait_for_progress', { projectId: p.id, timeoutSec: 5 })
      last = next
      if (!next.running) break
    }
    expect(last).toMatchObject({ status: 'done', running: false })
    const out = await call<{ path: string; catalog: string; lang: string; keys: number }>(c, 'export_project', { projectId: p.id })
    expect(out.lang).toBe('hr')
    expect(out.keys).toBe(allBlocks(await readVnPack(book)).length)
    expect(path.basename(out.path)).toBe(`${pack.book.slug}.hr`)
    expect((await readJson<CatalogJson>(out.catalog)).endings['2']).toBe('[hr] bittersweet: the boat is found, empty')
  })
})

describe('visual-novel folder: puzzle lines and kept marker bytes (BTT-23 legacy safety)', () => {
  it('classifies CLUE/EVIDENCE/PUZZLE/TESTIMONY/END TESTIMONY before the speaker line, with the Croatian keywords', () => {
    expect(classifyScriptLine('CLUE: dinner/c2: The rope was in the kitchen or the garden.')).toMatchObject({
      cls: 'clue',
      prefix: 'CLUE: dinner/c2: ',
      text: 'The rope was in the kitchen or the garden.'
    })
    expect(classifyScriptLine('TRAG: dinner/c2: Uže je bilo u kuhinji.')).toMatchObject({ cls: 'clue', prefix: 'TRAG: dinner/c2: ' })
    expect(classifyScriptLine('EVIDENCE: pocket_watch: A pocket watch, stopped at 9:10.')).toMatchObject({
      cls: 'evidence',
      prefix: 'EVIDENCE: pocket_watch: ',
      text: 'A pocket watch, stopped at 9:10.'
    })
    expect(classifyScriptLine('DOKAZ: pocket_watch: Džepni sat.')).toMatchObject({ cls: 'evidence', prefix: 'DOKAZ: pocket_watch: ' })
    expect(classifyScriptLine('PUZZLE: dinner (murdle)')).toMatchObject({ cls: 'puzzle', text: '' })
    expect(classifyScriptLine('ZAGONETKA: dinner')).toMatchObject({ cls: 'puzzle', text: '' })
    expect(classifyScriptLine('TESTIMONY: Miss Cole')).toMatchObject({ cls: 'testimony', prefix: 'TESTIMONY: ', text: 'Miss Cole' })
    expect(classifyScriptLine('SVJEDOČENJE: Gospođica Cole')).toMatchObject({ cls: 'testimony', text: 'Gospođica Cole' })
    expect(classifyScriptLine('END TESTIMONY')).toMatchObject({ cls: 'testimonyEnd', text: '' })
    expect(classifyScriptLine('KRAJ SVJEDOČENJA')).toMatchObject({ cls: 'testimonyEnd', text: '' })
    // a line that does not fit the puzzle grammar stays a speaker line, as in Scriptorium
    expect(classifyScriptLine('CLUE: no slash here')).toMatchObject({ cls: 'line', prefix: 'CLUE: ' })
    expect(classifyScriptLine('PUZZLE: not only a key')).toMatchObject({ cls: 'line', prefix: 'PUZZLE: ' })
  })

  it('translates the prose of CLUE and EVIDENCE, keeps their ids and labels, and leaves PUZZLE and END TESTIMONY whole', async () => {
    const dir = await tmp()
    const src = path.join(dir, 'puzzle-book')
    await fs.mkdir(path.join(src, 'chapters'), { recursive: true })
    await fs.writeFile(path.join(src, 'book.md'), '---\ntitle: A Puzzle Book\n---\n', 'utf8')
    const script = [
      '---',
      'n: 1',
      'title: The Dinner',
      '---',
      '',
      'SCENE: The kitchen, night',
      'Rain on the window.',
      'CLUE: dinner/c2: The rope was either in the kitchen or the garden.',
      'EVIDENCE: pocket_watch: A pocket watch, stopped at 9:10.',
      'PUZZLE: dinner (murdle)',
      'TESTIMONY: Miss Cole',
      'MISS COLE (calm): I was in the garden all evening.',
      'END TESTIMONY',
      ''
    ].join('\n')
    await fs.writeFile(path.join(src, 'chapters', 'ch-01.md'), script, 'utf8')

    const ir = await readVnFolder(src)
    expect(blockTexts(ir)).toEqual([
      'A Puzzle Book',
      'The Dinner',
      'The kitchen, night',
      'Rain on the window.',
      'The rope was either in the kitchen or the garden.',
      'A pocket watch, stopped at 9:10.',
      'Miss Cole',
      '<1>MISS COLE (calm):</1> I was in the garden all evening.'
    ])
    const answers: Record<string, string> = {
      'A Puzzle Book': 'Knjiga zagonetki',
      'The Dinner': 'Večera',
      'The kitchen, night': 'Kuhinja, noć',
      'Rain on the window.': 'Kiša na prozoru.',
      'The rope was either in the kitchen or the garden.': 'Uže je bilo ili u kuhinji ili u vrtu.',
      'A pocket watch, stopped at 9:10.': 'Džepni sat, zaustavljen u 9:10.',
      'Miss Cole': 'Gospođica Cole',
      '<1>MISS COLE (calm):</1> I was in the garden all evening.': '<1>MISS COLE (calm):</1> Bila sam cijelu večer u vrtu.'
    }
    const tr = new Map(allBlocks(ir).map((b) => [b.id, answers[b.text] ?? b.text]))
    const out = path.join(dir, 'puzzle-book.hr')
    const warnings: string[] = []
    await writeVnFolder(tr, src, out, { targetLanguage: 'hr', onWarning: (m) => warnings.push(m) })
    expect(warnings).toEqual([])
    const result = await fs.readFile(path.join(out, 'chapters', 'ch-01.md'), 'utf8')
    expect(result.split('\n')).toHaveLength(script.split('\n').length)
    expect(result).toContain('CLUE: dinner/c2: Uže je bilo ili u kuhinji ili u vrtu.')
    expect(result).toContain('EVIDENCE: pocket_watch: Džepni sat, zaustavljen u 9:10.')
    expect(result).toContain('PUZZLE: dinner (murdle)')
    expect(result).toContain('END TESTIMONY')
    expect(result).toContain('TESTIMONY: Gospođica Cole')
    expect(result).toContain('MISS COLE (calm): Bila sam cijelu večer u vrtu.')
    // the kept bytes are exactly the source's
    const kept = (line: string) => line.slice(0, line.indexOf(': ', line.indexOf(': ') + 2) + 2)
    expect(kept(result.split('\n').find((l) => l.startsWith('CLUE:'))!)).toBe('CLUE: dinner/c2: ')
    expect(kept(result.split('\n').find((l) => l.startsWith('EVIDENCE:'))!)).toBe('EVIDENCE: pocket_watch: ')
  })

  it('localizes the witness of TESTIMONY like the names of ON SCREEN lines', () => {
    expect(localizeScriptNames('TESTIMONY: Miss Cole\nEND TESTIMONY\n', { 'miss cole': 'Gospođica Cole' }, 'hr')).toBe('TESTIMONY: Gospođica Cole\nEND TESTIMONY\n')
    expect(localizeScriptNames('TESTIMONY: Miss Cole\n', { 'miss cole': 'Cole\nova' }, 'hr')).toBe('TESTIMONY: Miss Cole\n')
  })

  it('keeps a source line whose marker bytes the translation would change', async () => {
    const dir = await tmp()
    const src = path.join(dir, 'marker-book')
    await fs.mkdir(path.join(src, 'chapters'), { recursive: true })
    await fs.writeFile(path.join(src, 'book.md'), '---\ntitle: Markers\n---\n', 'utf8')
    const script = ['---', 'n: 1', 'title: One', '---', '', '## One thing', 'Narration: Rain.', ''].join('\n')
    await fs.writeFile(path.join(src, 'chapters', 'ch-01.md'), script, 'utf8')
    const ir = await readVnFolder(src)
    const answers: Record<string, string> = { 'One thing': 'Naslov #', 'Rain.': 'Kiša.' }
    const tr = new Map(allBlocks(ir).map((b) => [b.id, answers[b.text] ?? b.text]))
    const out = path.join(dir, 'marker-book.hr')
    const warnings: string[] = []
    await writeVnFolder(tr, src, out, { targetLanguage: 'hr', onWarning: (m) => warnings.push(m) })
    // the heading would gain a `#` marker: the source line is kept, with a warning
    expect(await fs.readFile(path.join(out, 'chapters', 'ch-01.md'), 'utf8')).toContain('## One thing')
    expect(warnings.join('\n')).toMatch(/would change the kind of script line/)
  })
})
