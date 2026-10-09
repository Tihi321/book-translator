import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
