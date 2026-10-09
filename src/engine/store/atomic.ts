import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ZodType, z } from 'zod'
import { parseMd, parseMdWith, serializeMd } from '../../shared/md'
import type { MdDoc } from '../../shared/md'

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

export interface AtomicOptions {
  /** How many times to retry a rename that Windows refuses (editor, antivirus). Default 8. */
  retries?: number
  /** First backoff in ms, doubled each retry. Default 25. */
  backoffMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Suffix used for temporary files. The watcher ignores anything that matches `.tmp-`. */
export const TMP_MARKER = '.tmp-'

/** Writes `<file>.tmp-<rand>` and renames it over the target, retrying on EBUSY/EPERM/EACCES. */
export async function atomicWrite(file: string, content: string, opts: AtomicOptions = {}): Promise<void> {
  const retries = opts.retries ?? 8
  const backoff = opts.backoffMs ?? 25
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}${TMP_MARKER}${randomBytes(4).toString('hex')}`
  await fs.writeFile(tmp, content, 'utf8')
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= retries || !code || !RETRY_CODES.has(code)) throw err
        await sleep(backoff * 2 ** attempt)
      }
    }
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/** `fs.rename` that retries on EBUSY/EPERM/EACCES (Windows: a scanner or an editor holds the file for a moment). ENOENT and the rest throw at once. */
export async function renameRetry(from: string, to: string, opts: AtomicOptions = {}): Promise<void> {
  const retries = opts.retries ?? 8
  const backoff = opts.backoffMs ?? 25
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= retries || !code || !RETRY_CODES.has(code)) throw err
      await sleep(backoff * 2 ** Math.min(attempt, 4))
    }
  }
}

export async function readMd(file: string): Promise<MdDoc> {
  return parseMd(await fs.readFile(file, 'utf8'), file)
}

export async function readMdWith<S extends ZodType>(file: string, schema: S): Promise<MdDoc<z.output<S>>> {
  return parseMdWith(await fs.readFile(file, 'utf8'), schema, file)
}

export async function writeMd(
  file: string,
  data: Record<string, unknown>,
  body = '',
  opts?: AtomicOptions
): Promise<void> {
  await atomicWrite(file, serializeMd(data, body), opts)
}
