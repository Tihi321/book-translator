import { execFile } from 'node:child_process'
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

/** What the lock file says about its owner: line 1 the pid, then the start time (ms since the epoch) and the process name (older locks: the pid alone). */
export interface LockInfo {
  pid: number
  startMs?: number
  name?: string
}

/** What the system says about a running process. */
export interface ProcessInfo {
  name: string
  startMs?: number
}

/** Looks a process up: its info, `undefined` when there is no such process, `null` when it cannot be told (then the lock is respected). */
export type ProcessLookup = (pid: number) => Promise<ProcessInfo | undefined | null>

/** Clock readings of the OS and of this process differ by a little: start times within this many ms are the same process. */
const START_TOLERANCE_MS = 10_000

const processName = (p: string) => path.basename(p).replace(/\.exe$/i, '').toLowerCase()

/** The identity of this process, written into the lock. */
export function ownInfo(pid = process.pid): LockInfo {
  return { pid, startMs: Math.round(Date.now() - process.uptime() * 1000), name: processName(process.execPath) }
}

function parseLock(text: string): LockInfo | undefined {
  const [first, second, ...rest] = text.split(/\r?\n/)
  const pid = Number.parseInt((first ?? '').trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const info: LockInfo = { pid }
  const startMs = Number.parseInt((second ?? '').trim(), 10)
  if (Number.isInteger(startMs) && startMs > 0) info.startMs = startMs
  const name = rest.join(' ').trim()
  if (name) info.name = name
  return info
}

const serializeLock = (i: LockInfo) => [i.pid, i.startMs ?? '', i.name ?? ''].join('\n')

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    return parseLock(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

const run = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string; missing: boolean }>((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? ''), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' }))
  })

/** The system's view of a pid: PowerShell `Get-Process` on Windows, `ps` elsewhere. */
export const systemProcessInfo: ProcessLookup = async (pid) => {
  if (pid === process.pid) return { name: processName(process.execPath), startMs: ownInfo(pid).startMs }
  if (process.platform === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName; try { [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() } catch {} }; exit 0`
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    if (!r.ok) return null
    const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) return undefined
    const startMs = Number.parseInt(lines[1] ?? '', 10)
    return { name: lines[0]!.toLowerCase(), startMs: Number.isInteger(startMs) ? startMs : undefined }
  }
  const r = await run('ps', ['-o', 'etimes=,comm=', '-p', String(pid)])
  const m = /^\s*(\d+)\s+(.+?)\s*$/m.exec(r.out)
  if (!m) return r.missing ? null : undefined
  return { name: processName(m[2]!), startMs: Date.now() - Number(m[1]) * 1000 }
}

/** A process name that can be a Book Translator engine: the app itself, Electron or Node (`serve` and `headless` run on Node). */
const looksLikeEngine = (name: string) => /book.?translator|^node|electron/i.test(name)

/**
 * Does the lock still belong to a running engine? The pid must be alive, and be the same process: with a start time in the lock it must match
 * the live process's start time (a reused pid starts later); without one (an older lock, or a start time the system would not give) the live
 * process's name must look like an engine (Book Translator, Node, Electron). When the system cannot say, the lock is respected.
 */
export async function lockHolderAlive(info: LockInfo, lookup: ProcessLookup = systemProcessInfo): Promise<boolean> {
  if (!pidAlive(info.pid)) return false
  const live = await lookup(info.pid)
  if (live === undefined) return false
  if (live === null) return true
  if (info.startMs !== undefined && live.startMs !== undefined) return Math.abs(info.startMs - live.startMs) <= START_TOLERANCE_MS
  return looksLikeEngine(live.name)
}

/**
 * One engine per data folder: writes `engine.lock` (the pid, start time and name) with an exclusive create. A lock whose process is gone,
 * or whose pid now belongs to an unrelated process, is taken over. A live engine's lock throws, so a second engine (`serve`, `headless`)
 * never works on the same projects as the first.
 */
export async function acquireDataLock(dataDir: string, pid = process.pid, lookup: ProcessLookup = systemProcessInfo): Promise<DataLock> {
  const file = path.join(dataDir, LOCK_FILE)
  await fs.mkdir(dataDir, { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.writeFile(file, serializeLock(ownInfo(pid)), { flag: 'wx' })
      return {
        file,
        release: async () => {
          if ((await readLock(file))?.pid === pid) await fs.rm(file, { force: true })
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const other = await readLock(file)
    if (other !== undefined && other.pid !== pid && (await lockHolderAlive(other, lookup))) throw new Error(`another Book Translator engine is using ${dataDir} (pid ${other.pid})`)
    // stale (dead pid, a reused pid, or an empty file): remove it and try the exclusive create again
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
