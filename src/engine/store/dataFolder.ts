import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Folders created inside the data folder. */
export const DATA_LAYOUT = ['config', 'prompts', 'projects'] as const

export interface ResolveOptions {
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  homedir?: string
}

/** Reads `--data <dir>` or `--data=<dir>` from an argument list. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === `--${name}`) return argv[i + 1]
    if (a?.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return undefined
}

/** `--data` argument, then the BOOK_TRANSLATOR_DATA env var, then `~/BookTranslator` (%USERPROFILE%\BookTranslator). */
export function resolveDataDir(opts: ResolveOptions = {}): string {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const chosen = argValue(argv, 'data') || env.BOOK_TRANSLATOR_DATA || path.join(opts.homedir ?? os.homedir(), 'BookTranslator')
  return path.resolve(chosen)
}

/** Finds the repo's `seed/` folder: BOOK_TRANSLATOR_SEED, else walk up from this file. */
export function findSeedDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BOOK_TRANSLATOR_SEED) return path.resolve(env.BOOK_TRANSLATOR_SEED)
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'seed')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export interface InitResult {
  dataDir: string
  createdDirs: number
  copied: string[]
  skipped: string[]
}

async function copyTree(src: string, dest: string, root: string, result: InitResult): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to, root, result)
    } else if (entry.isFile()) {
      const rel = path.relative(root, to).split(path.sep).join('/')
      try {
        // COPYFILE_EXCL: never overwrite a file that already exists.
        await fs.copyFile(from, to, 1)
        result.copied.push(rel)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') result.skipped.push(rel)
        else throw err
      }
    }
  }
}

/** Creates the data folder layout and copies `seed/` into it. Existing files are never overwritten. */
export async function initDataFolder(dataDir: string, seedDir: string | undefined = findSeedDir()): Promise<InitResult> {
  const result: InitResult = { dataDir, createdDirs: 0, copied: [], skipped: [] }
  await fs.mkdir(dataDir, { recursive: true })
  if (seedDir && existsSync(seedDir)) await copyTree(seedDir, dataDir, dataDir, result)
  for (const rel of DATA_LAYOUT) {
    const dir = path.join(dataDir, ...rel.split('/'))
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true })
      result.createdDirs++
    }
  }
  return result
}
