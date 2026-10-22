import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { Document, Node, YAMLSeq } from 'yaml'
import { splitFrontmatter } from '../../shared/md'
import { providersSchema } from '../../shared/schemas'
import { atomicWrite } from './atomic'

/**
 * The providers seed/config/providers.md had before `seed-state.json` existed. A data folder without that file was offered these:
 * one the user removed from it is not added back, and one the seed gained since (`client`) is.
 */
export const LEGACY_SEED_PROVIDERS = ['deepseek', 'openai', 'openrouter', 'anthropic', 'gemini', 'lmstudio', 'strata', 'ollama', 'custom', 'mock']

/** Where the migration records every provider the seed has offered this data folder. */
export const SEED_STATE_FILE = path.join('config', 'seed-state.json')

export interface MigrationResult {
  /** Ids of the providers copied into config/providers.md from the seed. */
  added: string[]
  warnings: string[]
}

interface Parsed {
  doc: Document
  providers: YAMLSeq
  /** The frontmatter as written, and where it starts in the file. */
  front: string
  frontStart: number
  text: string
  nl: string
}

/** The frontmatter of a providers.md as a yaml document (positions kept), or why it can't be used. */
function parseProviders(text: string, what: string): Parsed | string {
  const { frontmatter } = splitFrontmatter(text)
  if (frontmatter === null) return `${what} has no frontmatter`
  const doc = parseDocument(frontmatter)
  if (doc.errors.length) return `${what} is not valid YAML (${doc.errors[0]!.message})`
  const providers = doc.get('providers')
  if (!isSeq(providers)) return `${what} has no providers list`
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const frontStart = bom + text.slice(bom).indexOf('\n') + 1
  return { doc, providers, front: frontmatter, frontStart, text, nl: text.includes('\r\n') ? '\r\n' : '\n' }
}

/** Where the entry `providers.items[i]` starts in the frontmatter: its line, or the first of the comment lines right above it. */
function entryStart(p: Parsed, i: number): number {
  const item = p.providers.items[i] as Node
  let at = p.front.lastIndexOf('\n', item.range![0]) + 1
  while (at > 0) {
    const prev = p.front.lastIndexOf('\n', at - 2) + 1
    if (!p.front.slice(prev, at).trim().startsWith('#')) break
    at = prev
  }
  return at
}

/** Where the providers list ends in the frontmatter: after its last line. */
function listEnd(p: Parsed): number {
  const end = p.providers.range![1]
  const nl = p.front.indexOf('\n', Math.max(0, end - 1))
  return nl === -1 ? p.front.length : nl + 1
}

const idOf = (item: unknown): string | undefined => {
  const id = isMap(item) ? item.get('id') : undefined
  return typeof id === 'string' ? id : undefined
}

const idsOf = (seq: YAMLSeq): string[] => seq.items.map(idOf).filter((id): id is string => id !== undefined)

async function readState(file: string): Promise<string[] | undefined> {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8')) as { providers?: unknown }
    return Array.isArray(data.providers) ? data.providers.filter((p): p is string => typeof p === 'string') : undefined
  } catch {
    return undefined
  }
}

async function writeState(file: string, ids: Iterable<string>): Promise<void> {
  const providers = [...new Set(ids)].sort()
  if (JSON.stringify(await readState(file)) !== JSON.stringify(providers)) await atomicWrite(file, JSON.stringify({ providers }, null, 2) + '\n')
}

/**
 * Copies the providers a newer seed has into an existing config/providers.md, once each. Existing entries, comments and order stay as
 * they are, and a provider the user deleted is not added back: `config/seed-state.json` lists every provider the seed offered. A folder
 * without that file is an older one: it was offered `LEGACY_SEED_PROVIDERS` and the ids in its file. A file that can't be read, or would
 * be invalid after the change, is left alone (a warning says why and nothing is recorded, so the next start tries again).
 * `fresh`: providers.md was just copied from the seed, so only the state is written.
 */
export async function migrateProviders(dataDir: string, seedDir: string, opts: { fresh: boolean }): Promise<MigrationResult> {
  const result: MigrationResult = { added: [], warnings: [] }
  const file = path.join(dataDir, 'config', 'providers.md')
  const stateFile = path.join(dataDir, SEED_STATE_FILE)
  const seed = parseProviders(await fs.readFile(path.join(seedDir, 'config', 'providers.md'), 'utf8'), 'the seed config/providers.md')
  if (typeof seed === 'string') {
    result.warnings.push(`${seed}: the providers it gained were not copied in`)
    return result
  }
  const seedIds = idsOf(seed.providers)
  if (opts.fresh) {
    await writeState(stateFile, seedIds)
    return result
  }

  const mine = parseProviders(await fs.readFile(file, 'utf8'), 'config/providers.md')
  if (typeof mine === 'string') {
    result.warnings.push(`${mine}: the providers the seed gained were not copied in`)
    return result
  }
  const have = new Set(idsOf(mine.providers))
  const offered = new Set((await readState(stateFile)) ?? [...LEGACY_SEED_PROVIDERS, ...have])
  const missing = seedIds.filter((id) => !have.has(id) && !offered.has(id))

  if (missing.length) {
    // the entries are copied as text, so the file keeps its comments, spacing and order, and the new ones are as the seed has them
    const mock = mine.providers.items.findIndex((item) => idOf(item) === 'mock')
    const insertAt = mock === -1 ? listEnd(mine) : entryStart(mine, mock)
    let add = ''
    for (const id of missing) {
      const k = seed.providers.items.findIndex((item) => idOf(item) === id)
      const to = k + 1 < seed.providers.items.length ? entryStart(seed, k + 1) : listEnd(seed)
      add += seed.front.slice(entryStart(seed, k), to).replace(/\r\n/g, '\n')
    }
    if (!add.endsWith('\n')) add += '\n'
    let front = mine.front.slice(0, insertAt) + add.replace(/\n/g, mine.nl) + mine.front.slice(insertAt)
    if (insertAt > 0 && front[insertAt - 1] !== '\n') front = front.slice(0, insertAt) + mine.nl + front.slice(insertAt)
    const doc = parseDocument(front)
    const check = doc.errors.length ? undefined : providersSchema.safeParse(doc.toJS())
    if (!check?.success) {
      result.warnings.push(`config/providers.md would be invalid with ${missing.join(', ')} added (${doc.errors[0]?.message ?? check?.error.issues[0]?.message ?? '?'}): left as it is`)
      return result
    }
    await atomicWrite(file, mine.text.slice(0, mine.frontStart) + front + mine.text.slice(mine.frontStart + mine.front.length))
    result.added = missing
  }
  await writeState(stateFile, [...offered, ...seedIds])
  return result
}

/** True when the seed has a providers.md to migrate from. */
export function seedHasProviders(seedDir: string): boolean {
  return existsSync(path.join(seedDir, 'config', 'providers.md'))
}
