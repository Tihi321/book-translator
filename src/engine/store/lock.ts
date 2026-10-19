import { promises as fs, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

export const LOCK_FILE = 'engine.lock'

export interface DataLock {
  file: string
  /** Removes the lock file (only when it is still ours). */
  release: () => Promise<void>
}

/** Is a process with this pid running? (EPERM means it runs but belongs to someone else.) */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const n = Number.parseInt((await fs.readFile(file, 'utf8')).trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

/**
 * One engine per data folder: writes `engine.lock` (the pid) with an exclusive create. A lock whose process is gone is taken over.
 * A live one throws, so a second engine (`serve`, `headless`) never works on the same projects as the first.
 */
export async function acquireDataLock(dataDir: string, pid = process.pid): Promise<DataLock> {
  const file = path.join(dataDir, LOCK_FILE)
  await fs.mkdir(dataDir, { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.writeFile(file, String(pid), { flag: 'wx' })
      return {
        file,
        release: async () => {
          if ((await readPid(file)) === pid) await fs.rm(file, { force: true })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const other = await readPid(file)
    if (other !== undefined && other !== pid && pidAlive(other)) throw new Error(`another Book Translator engine is using ${dataDir} (pid ${other})`)
    // stale (dead pid, or an empty file): remove it and try the exclusive create again
    await fs.rm(file, { force: true })
  }
  throw new Error(`could not lock ${dataDir} (${file})`)
}

/** Removes the lock file when the process ends (also on a crash that still runs 'exit'). */
export function releaseOnExit(lock: DataLock, pid = process.pid): void {
  process.once('exit', () => {
    try {
      if (Number.parseInt(readFileSync(lock.file, 'utf8'), 10) === pid) rmSync(lock.file, { force: true })
    } catch {
      // already gone
    }
  })
}
