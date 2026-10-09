import { createRequire } from 'node:module'

/** API keys live in environment variables or the Windows credential store. Never in files. */
export const KEYRING_SERVICE = 'book-translator'

interface KeyringEntry {
  setPassword(p: string): void
  getPassword(): string | null
  deletePassword(): boolean
}
type EntryCtor = new (service: string, account: string) => KeyringEntry

let entryCtor: EntryCtor | null | undefined

function loadEntry(): EntryCtor | null {
  if (entryCtor !== undefined) return entryCtor
  try {
    const req = createRequire(__filename)
    entryCtor = (req('@napi-rs/keyring') as { Entry: EntryCtor }).Entry
  } catch {
    entryCtor = null
  }
  return entryCtor
}

function entry(account: string, service: string): KeyringEntry {
  const Ctor = loadEntry()
  if (!Ctor) throw new Error('The credential store module (@napi-rs/keyring) could not be loaded')
  return new Ctor(service, account)
}

export function setStoredKey(account: string, value: string, service = KEYRING_SERVICE): void {
  entry(account, service).setPassword(value)
}

export function getStoredKey(account: string, service = KEYRING_SERVICE): string | undefined {
  try {
    return entry(account, service).getPassword() ?? undefined
  } catch {
    return undefined
  }
}

export function deleteStoredKey(account: string, service = KEYRING_SERVICE): boolean {
  try {
    return entry(account, service).deletePassword()
  } catch {
    return false
  }
}

export type KeyResolver = (envName: string) => string | undefined

/** The environment variable first, then the Windows credential store (account = the variable name). */
export const resolveKey: KeyResolver = (envName) => {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  return getStoredKey(envName)
}
