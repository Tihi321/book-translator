import { randomBytes } from 'node:crypto'
import { resolveKey, setStoredKey } from '../models/keys'
import type { KeyResolver } from '../models/keys'

/** Name of the credential-store entry (and the environment variable that overrides it) holding the MCP bearer token. */
export const MCP_TOKEN_NAME = 'BOOK_TRANSLATOR_MCP_TOKEN'

/**
 * The bearer token the MCP server asks for: the environment variable, else the credential store, else a new random one that is stored
 * (when the store can't be written, it is kept for this run only).
 */
export function getOrCreateMcpToken(keys: KeyResolver = resolveKey, storeKey: (name: string, value: string) => void = setStoredKey): string {
  const existing = keys(MCP_TOKEN_NAME)
  if (existing) return existing
  const token = randomBytes(24).toString('base64url')
  try {
    storeKey(MCP_TOKEN_NAME, token)
  } catch {
    // no credential store: the token lives for this run
  }
  return token
}
