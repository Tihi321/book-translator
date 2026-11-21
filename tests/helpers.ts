import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

/** BTT-36: the seed switches `strata` and `lmstudio` off. Tests of those (kept) providers switch them back on in a seeded folder. */
export async function enableDirectLocal(dir: string): Promise<void> {
  const file = path.join(dir, 'config', 'providers.md')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace(/^(\s+)enabled: false(\s+# off since BTT-36.*)$/gm, '$1enabled: true$2'))
}

/** A data folder seeded from seed/, with a loaded registry (every provider key resolves to "test-key"). `strata` and `lmstudio` are switched on again unless `seedOnly`. */
export async function seededRegistry(opts: RegistryOptions & { seedOnly?: boolean } = {}): Promise<{ dir: string; registry: ModelRegistry; cleanup: () => Promise<void> }> {
  const { seedOnly, ...registryOpts } = opts
  const { dir, cleanup } = await tempDir()
  await initDataFolder(dir, SEED_DIR)
  if (!seedOnly) await enableDirectLocal(dir)
  const registry = new ModelRegistry(dir, { keys: () => 'test-key', ...registryOpts })
  await registry.load()
  return { dir, registry, cleanup }
}
