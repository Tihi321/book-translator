import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import type { YAMLMap, YAMLSeq } from 'yaml'
import { ModelRegistry } from '../src/engine/models/registry'
import { parseMd, parseMdWith, splitFrontmatter } from '../src/shared/md'
import { providersSchema } from '../src/shared/schemas'
import { argValue, initDataFolder, resolveDataDir } from '../src/engine/store/dataFolder'
import { SEED_DIR, tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe('data folder', () => {
  it('resolves --data, then BOOK_TRANSLATOR_DATA, then ~/BookTranslator', () => {
    expect(resolveDataDir({ argv: ['--data', 'C:\\x\\a'], env: { BOOK_TRANSLATOR_DATA: 'C:\\x\\b' } })).toBe(path.resolve('C:\\x\\a'))
    expect(resolveDataDir({ argv: ['--data=C:\\x\\a'], env: {} })).toBe(path.resolve('C:\\x\\a'))
    expect(resolveDataDir({ argv: [], env: { BOOK_TRANSLATOR_DATA: 'C:\\x\\b' } })).toBe(path.resolve('C:\\x\\b'))
    expect(resolveDataDir({ argv: [], env: {}, homedir: 'C:\\Users\\me' })).toBe(path.resolve('C:\\Users\\me', 'BookTranslator'))
    expect(argValue(['parse', 'f.md'], 'data')).toBeUndefined()
  })

  it('seeds on first run and never overwrites existing files', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const first = await initDataFolder(dir, SEED_DIR)
    expect(first.copied).toContain('config/providers.md')
    expect(first.copied).toContain('config/defaults.json')
    for (const d of ['config', 'prompts', 'projects']) expect((await fs.stat(path.join(dir, d))).isDirectory()).toBe(true)

    const file = path.join(dir, 'config', 'providers.md')
    await fs.writeFile(file, 'edited', 'utf8')
    await fs.rm(path.join(dir, 'config', 'defaults.json'))
    const second = await initDataFolder(dir, SEED_DIR)
    expect(second.copied).toEqual(['config/defaults.json'])
    expect(second.skipped).toContain('config/providers.md')
    expect(await fs.readFile(file, 'utf8')).toBe('edited')
  })
})

/** providers.md the way a folder from before BTT-09 had it: no `client` and no `ollama`, a note of the user's and `deepseek` at 3 at once. */
async function makeLegacy(dir: string): Promise<{ text: string; body: string }> {
  const file = path.join(dir, 'config', 'providers.md')
  const { frontmatter, body } = splitFrontmatter(await fs.readFile(file, 'utf8'))
  const doc = parseDocument(frontmatter!)
  const providers = doc.get('providers') as YAMLSeq
  providers.items = providers.items.filter((i) => !['client', 'ollama'].includes(String((i as YAMLMap).get('id'))))
  const deepseek = providers.items.find((i) => (i as YAMLMap).get('id') === 'deepseek') as YAMLMap
  deepseek.set('concurrency', 3)
  doc.commentBefore = ' my note'
  const text = `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`
  await fs.writeFile(file, text, 'utf8')
  await fs.rm(path.join(dir, 'config', 'seed-state.json'), { force: true })
  return { text, body }
}

const providerIds = async (dir: string) => (parseMd(await fs.readFile(path.join(dir, 'config', 'providers.md'), 'utf8')).data.providers as { id: string }[]).map((p) => p.id)

describe('seed migration', () => {
  it('a fresh folder is the seed, with the state of what was offered', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const res = await initDataFolder(dir, SEED_DIR)
    expect(res.migrated).toEqual([])
    expect(res.warnings).toEqual([])
    expect(await fs.readFile(path.join(dir, 'config', 'providers.md'), 'utf8')).toBe(await fs.readFile(path.join(SEED_DIR, 'config', 'providers.md'), 'utf8'))
    const state = JSON.parse(await fs.readFile(path.join(dir, 'config', 'seed-state.json'), 'utf8')) as { providers: string[] }
    expect(state.providers).toEqual([...state.providers].sort())
    expect(state.providers).toEqual(expect.arrayContaining(['client', 'deepseek', 'mock']))
  })

  it('adds client to a folder from before it, keeping the edits, the comments and the rest of the file', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    const before = await makeLegacy(dir)
    const res = await initDataFolder(dir, SEED_DIR)
    expect(res.migrated).toEqual(['client'])
    expect(res.warnings).toEqual([])
    const file = path.join(dir, 'config', 'providers.md')
    const text = await fs.readFile(file, 'utf8')
    expect(text).toContain('# my note')
    expect(text).toContain('# Answered by an MCP client')
    expect(splitFrontmatter(text).body).toBe(before.body)
    const ids = await providerIds(dir)
    expect(ids).not.toContain('ollama')
    expect(ids.indexOf('client')).toBe(ids.indexOf('mock') - 1)
    const parsed = parseMdWith(text, providersSchema, file)
    expect(parsed.data.providers.find((p) => p.id === 'deepseek')!.concurrency).toBe(3)
    expect(parsed.data.providers.find((p) => p.id === 'client')).toMatchObject({ enabled: true, local: true, concurrency: 8 })
    const registry = new ModelRegistry(dir, { keys: () => 'k' })
    await registry.load()
    expect(registry.providers.get('client')).toMatchObject({ available: true, local: true })
    expect(registry.contextLength('client/claude-code')).toBe(200000)
  })

  it('does nothing the second time', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    await makeLegacy(dir)
    await initDataFolder(dir, SEED_DIR)
    const files = ['providers.md', 'seed-state.json'].map((f) => path.join(dir, 'config', f))
    const first = await Promise.all(files.map((f) => fs.readFile(f, 'utf8')))
    const res = await initDataFolder(dir, SEED_DIR)
    expect(res.migrated).toEqual([])
    expect(await Promise.all(files.map((f) => fs.readFile(f, 'utf8')))).toEqual(first)
  })

  it('does not bring back a provider the user deleted', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    await makeLegacy(dir)
    await initDataFolder(dir, SEED_DIR) // adds client
    const file = path.join(dir, 'config', 'providers.md')
    const { frontmatter, body } = splitFrontmatter(await fs.readFile(file, 'utf8'))
    const doc = parseDocument(frontmatter!)
    const providers = doc.get('providers') as YAMLSeq
    providers.items = providers.items.filter((i) => (i as YAMLMap).get('id') !== 'client')
    await fs.writeFile(file, `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`, 'utf8')
    const res = await initDataFolder(dir, SEED_DIR)
    expect(res.migrated).toEqual([])
    expect(await providerIds(dir)).not.toContain('client')
    // a folder that lost its state counts as an old one: it stays without ollama, which the old seed had, and gets client again
    await fs.rm(path.join(dir, 'config', 'seed-state.json'))
    expect((await initDataFolder(dir, SEED_DIR)).migrated).toEqual(['client'])
    expect(await providerIds(dir)).not.toContain('ollama')
  })

  it('keeps CRLF line endings and the body byte for byte', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    const file = path.join(dir, 'config', 'providers.md')
    await makeLegacy(dir)
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\n/g, '\r\n'), 'utf8')
    const body = splitFrontmatter(await fs.readFile(file, 'utf8')).body
    expect((await initDataFolder(dir, SEED_DIR)).migrated).toEqual(['client'])
    const text = await fs.readFile(file, 'utf8')
    expect(/(?<!\r)\n/.test(text)).toBe(false)
    expect(splitFrontmatter(text).body).toBe(body)
  })

  it('leaves a providers.md it cannot read alone, warns once and records nothing', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await initDataFolder(dir, SEED_DIR)
    const file = path.join(dir, 'config', 'providers.md')
    await fs.writeFile(file, 'edited', 'utf8')
    await fs.rm(path.join(dir, 'config', 'seed-state.json'))
    const res = await initDataFolder(dir, SEED_DIR)
    expect(res.migrated).toEqual([])
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toMatch(/config\/providers\.md has no frontmatter/)
    expect(await fs.readFile(file, 'utf8')).toBe('edited')
    await expect(fs.stat(path.join(dir, 'config', 'seed-state.json'))).rejects.toThrow()
    await fs.writeFile(file, '---\nproviders: [unclosed\n---\n', 'utf8')
    const bad = await initDataFolder(dir, SEED_DIR)
    expect(bad.warnings).toHaveLength(1)
    expect(await fs.readFile(file, 'utf8')).toBe('---\nproviders: [unclosed\n---\n')
  })

  it('adds a provider a later seed has, and nothing else', async () => {
    const { dir, cleanup } = await tempDir()
    const seed = await tempDir()
    cleanups.push(cleanup, seed.cleanup)
    await initDataFolder(dir, SEED_DIR)
    await fs.cp(SEED_DIR, seed.dir, { recursive: true })
    const seedFile = path.join(seed.dir, 'config', 'providers.md')
    const text = await fs.readFile(seedFile, 'utf8')
    const extra = '  # a provider of a later version\n  - id: newone\n    kind: mock\n    models:\n      - id: n\n'
    const edited = text.replace(/(\r?\n)( {2}- id: mock\r?\n)/, (_m, nl: string, mock: string) => `${nl}${extra.replace(/\n/g, nl)}${mock}`)
    expect(edited).not.toBe(text)
    await fs.writeFile(seedFile, edited, 'utf8')
    const before = await fs.readFile(path.join(dir, 'config', 'providers.md'), 'utf8')
    const res = await initDataFolder(dir, seed.dir)
    expect(res.migrated).toEqual(['newone'])
    const after = await fs.readFile(path.join(dir, 'config', 'providers.md'), 'utf8')
    expect(after).toContain('# a provider of a later version')
    expect(after.replace(/ {2}# a provider of a later version\r?\n {2}- id: newone\r?\n {4}kind: mock\r?\n {4}models:\r?\n {6}- id: n\r?\n/, '')).toBe(before)
  })
})
