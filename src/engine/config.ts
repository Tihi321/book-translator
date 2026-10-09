import { promises as fs } from 'node:fs'
import path from 'node:path'
import { defaultsSchema } from '../shared/schemas'
import type { DefaultsConfig } from '../shared/schemas'

/** Reads config/defaults.json from the data folder. A missing file gives the schema defaults. */
export async function loadDefaults(dataDir: string): Promise<DefaultsConfig> {
  const file = path.join(dataDir, 'config', 'defaults.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultsSchema.parse({})
    throw err
  }
  let json: unknown
  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`, { cause: err })
  }
  const parsed = defaultsSchema.safeParse(json)
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return parsed.data
}

export interface LanguageInfo {
  code?: string
  name: string
  rtl?: boolean
}

/** Finds a language by code or name (case-insensitive). Unknown input is used as the name. */
export function resolveLanguage(defaults: DefaultsConfig, input: string): LanguageInfo {
  const q = input.trim().toLowerCase()
  const hit = defaults.languages.find((l) => l.code.toLowerCase() === q || l.name.toLowerCase() === q)
  return hit ? { code: hit.code, name: hit.name, rtl: hit.rtl } : { name: input.trim() }
}
