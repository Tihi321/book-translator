import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initDataFolder } from '../src/engine/store/dataFolder'
import { ModelRegistry } from '../src/engine/models/registry'
import type { RegistryOptions } from '../src/engine/models/registry'

export const SEED_DIR = path.resolve(__dirname, '..', 'seed')

export async function tempDir(prefix = 'bt-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A data folder seeded from seed/, with a loaded registry (every provider key resolves to "test-key"). */
export async function seededRegistry(opts: RegistryOptions = {}): Promise<{ dir: string; registry: ModelRegistry; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await tempDir()
  await initDataFolder(dir, SEED_DIR)
  const registry = new ModelRegistry(dir, { keys: () => 'test-key', ...opts })
  await registry.load()
  return { dir, registry, cleanup }
}
