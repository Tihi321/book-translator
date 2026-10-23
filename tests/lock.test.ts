import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireDataLock, LOCK_FILE, lockHolderAlive, ownInfo, pidAlive, systemProcessInfo } from '../src/engine/store/lock'
import { tempDir } from './helpers'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function folder(): Promise<string> {
  const t = await tempDir('bt-lock-')
  cleanup = t.cleanup
  return t.dir
}

/** The pid of a process that has ended. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

const lockPid = (text: string) => String(Number.parseInt(text, 10))

describe('data folder lock', () => {
  it('writes the pid, and a second engine is refused while the first lives', async () => {
    const dir = await folder()
    const first = await acquireDataLock(dir)
    expect(lockPid(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8'))).toBe(String(process.pid))
    // another engine (any pid but the one in the file)
    await expect(acquireDataLock(dir, process.pid + 100000)).rejects.toThrow(new RegExp(`another Book Translator engine is using .* \\(pid ${process.pid}\\)`))
    await first.release()
    await expect(fs.access(path.join(dir, LOCK_FILE))).rejects.toThrow()
    const again = await acquireDataLock(dir)
    await again.release()
  })

  it('takes over a lock whose process is gone', async () => {
    const dir = await folder()
    const dead = deadPid()
    expect(pidAlive(dead)).toBe(false)
    await fs.writeFile(path.join(dir, LOCK_FILE), String(dead))
    const lock = await acquireDataLock(dir)
    expect(lockPid(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8'))).toBe(String(process.pid))
    await lock.release()
  })

  it('takes over an empty or broken lock file', async () => {
    const dir = await folder()
    await fs.writeFile(path.join(dir, LOCK_FILE), 'not a pid')
    const lock = await acquireDataLock(dir)
    await lock.release()
  })

  it('release leaves a lock that another engine took over', async () => {
    const dir = await folder()
    const lock = await acquireDataLock(dir)
    await fs.writeFile(path.join(dir, LOCK_FILE), String(process.pid + 1))
    await lock.release()
    expect(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8')).toBe(String(process.pid + 1))
  })

  it('creates the data folder when it does not exist yet', async () => {
    const dir = path.join(await folder(), 'new', 'data')
    const lock = await acquireDataLock(dir)
    await lock.release()
  })
})

describe('lock with a reused pid', () => {
  const svchost = async () => ({ name: 'svchost', startMs: Date.now() })

  it('takes over an old lock (pid only) whose pid is now an unrelated process', async () => {
    const dir = await folder()
    await fs.writeFile(path.join(dir, LOCK_FILE), String(process.pid))
    const lock = await acquireDataLock(dir, process.pid + 100000, svchost)
    expect(lockPid(await fs.readFile(path.join(dir, LOCK_FILE), 'utf8'))).toBe(String(process.pid + 100000))
    await lock.release()
  })

  it('respects an old lock whose pid is a node or Electron process', async () => {
    const dir = await folder()
    await fs.writeFile(path.join(dir, LOCK_FILE), String(process.pid))
    await expect(acquireDataLock(dir, process.pid + 100000, async () => ({ name: 'node' }))).rejects.toThrow(/another Book Translator engine/)
    await expect(acquireDataLock(dir, process.pid + 100000, async () => ({ name: 'Book Translator' }))).rejects.toThrow(/another Book Translator engine/)
  })

  it('compares the start time in the lock with the live process', async () => {
    const mine = ownInfo()
    expect(await lockHolderAlive(mine, async () => ({ name: 'node', startMs: mine.startMs }))).toBe(true)
    // same name (a node process) but it started a day later: the pid was reused
    expect(await lockHolderAlive(mine, async () => ({ name: 'node', startMs: mine.startMs! + 86_400_000 }))).toBe(false)
    expect(await lockHolderAlive(mine, async () => undefined)).toBe(false)
    // the system cannot say: the lock is respected
    expect(await lockHolderAlive(mine, async () => null)).toBe(true)
  })

  it('a lock with a start time that does not match is taken over', async () => {
    const dir = await folder()
    await fs.writeFile(path.join(dir, LOCK_FILE), [process.pid, Date.now() - 86_400_000, 'node'].join(String.fromCharCode(10)))
    const lock = await acquireDataLock(dir, process.pid + 100000, async () => ({ name: 'node', startMs: Date.now() }))
    await lock.release()
  })

  it('the system lookup reads another live process, and knows a dead pid', async () => {
    const info = await systemProcessInfo(process.ppid || process.pid)
    expect(info?.name).toEqual(expect.any(String))
    expect(await systemProcessInfo(deadPid())).toBeUndefined()
  })
})
