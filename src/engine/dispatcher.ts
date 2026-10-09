import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { loadDefaults } from './config'
import { adapterFor, supportedExtensions } from './formats'
import { resolveKey, setStoredKey } from './models/keys'
import type { KeyResolver } from './models/keys'
import type { ModelRegistry } from './models/registry'
import { mergeSettings } from './project/store'
import { EngineService } from './service'
import { atomicWrite } from './store/atomic'
import { countTokens } from './tokens'
import { splitFrontmatter } from '../shared/md'
import type { DocumentIR } from '../shared/ir'
import { providersSchema } from '../shared/schemas'
import type { DefaultsConfig } from '../shared/schemas'
import type { AnalyzeResult, Command, EngineEvent, EngineInfo, EngineTransport, FileInfo, ModelsInfo, ProviderPatch } from '../shared/protocol'
import { isRequest } from '../shared/protocol'

export interface DispatcherOptions {
  service: EngineService
  emit: (ev: EngineEvent) => void
  /** Looks up API keys (environment, then the credential store). */
  keys?: KeyResolver
  /** Stores an API key (the credential store). */
  storeKey?: (name: string, value: string) => void
  /** Show the scripted `mock` provider's models (development and tests). */
  showMock?: boolean
}

const wordsOf = (text: string) => text.replace(/<\/?\d+\/?>/g, ' ').split(/\s+/).filter(Boolean).length

export function fileInfo(file: string, ir: DocumentIR): FileInfo {
  let blocks = 0
  let words = 0
  let tokens = 0
  for (const s of ir.sections) {
    for (const b of s.blocks) {
      blocks++
      words += wordsOf(b.text)
      tokens += countTokens(b.text)
    }
  }
  const adapter = adapterFor(file)
  return {
    path: file,
    format: ir.format,
    title: ir.meta.title,
    language: ir.meta.language,
    sections: ir.sections.length,
    blocks,
    words,
    tokens,
    outputExt: adapter.outputExt ?? path.extname(file)
  }
}

/**
 * Maps each protocol `Command` to EngineService / registry / config calls. Commands that return data return it here; the transport
 * layer (`serveEngine`) wraps it in a `reply` event. Commands that start long work (`start`, `retryChunk`) return at once and report through events.
 */
export class CommandDispatcher {
  private readonly service: EngineService
  private readonly keys: KeyResolver
  private readonly storeKey: (name: string, value: string) => void
  private discovery: ModelsInfo['discovery'] = []
  private readonly irCache = new Map<string, DocumentIR>()

  constructor(private readonly opts: DispatcherOptions) {
    this.service = opts.service
    this.keys = opts.keys ?? resolveKey
    this.storeKey = opts.storeKey ?? setStoredKey
  }

  private get registry(): ModelRegistry {
    return this.service.registry
  }

  private get dataDir(): string {
    return this.service.store.dataDir
  }

  info(): EngineInfo {
    return { dataDir: this.dataDir, extensions: supportedExtensions(), mock: this.opts.showMock === true }
  }

  /** Providers and models for the pickers: the mock provider is left out unless asked for. */
  modelsInfo(): ModelsInfo {
    const providers = [...this.registry.providers.values()].filter((p) => p.kind !== 'mock' || this.opts.showMock)
    const ids = new Set(providers.map((p) => p.id))
    return {
      providers: providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        local: p.local,
        baseUrl: p.baseUrl,
        apiKeyEnv: p.apiKeyEnv,
        hasKey: p.apiKeyEnv ? Boolean(this.keys(p.apiKeyEnv)) : false,
        concurrency: p.concurrency,
        available: p.available,
        unavailableReason: p.unavailableReason
      })),
      models: [...this.registry.models.values()]
        .filter((m) => ids.has(m.provider.id) && !m.embedding)
        .map((m) => ({
          ref: m.ref,
          provider: m.provider.id,
          model: m.id,
          family: m.family,
          local: m.provider.local,
          available: m.provider.available,
          context: this.registry.contextLength(m.ref),
          loaded: m.loadedContext !== undefined,
          priceIn: m.provider.local ? 0 : m.priceIn,
          priceOut: m.provider.local ? 0 : m.priceOut,
          discovered: m.discovered
        })),
      discovery: this.discovery
    }
  }

  /** Asks the local servers for their models. Used at startup and by `refreshModels`. */
  async discover(): Promise<ModelsInfo> {
    this.discovery = await this.registry.discover()
    return this.modelsInfo()
  }

  private async readSource(file: string): Promise<DocumentIR> {
    const abs = path.resolve(file)
    const stat = await fs.stat(abs)
    const key = `${abs}|${stat.mtimeMs}|${stat.size}`
    const cached = this.irCache.get(key)
    if (cached) return cached
    const ir = await adapterFor(abs).read(abs)
    this.irCache.clear()
    this.irCache.set(key, ir)
    return ir
  }

  private async analyze(cmd: Extract<Command, { type: 'analyze' }>): Promise<AnalyzeResult> {
    if (cmd.projectId) {
      const project = await this.service.getProject(cmd.projectId)
      const ir = await this.service.store.readIr(cmd.projectId)
      return { file: fileInfo(project.sourcePath, ir), estimate: this.service.estimate(ir, mergeSettings(project.settings, cmd.settings)) }
    }
    if (!cmd.sourcePath) throw new Error('analyze needs a projectId or a sourcePath')
    const file = path.resolve(cmd.sourcePath)
    const ir = await this.readSource(file)
    const base = await this.service.defaultSettings(cmd.targetLanguage || 'English', cmd.sourceLanguage || ir.meta.language)
    return { file: fileInfo(file, ir), estimate: this.service.estimate(ir, mergeSettings(base, cmd.settings)) }
  }

  /** Edits enabled / base_url / concurrency of providers in config/providers.md, keeping its comments and text. */
  private async saveProviders(patches: ProviderPatch[]): Promise<void> {
    const file = path.join(this.dataDir, 'config', 'providers.md')
    const text = await fs.readFile(file, 'utf8')
    const { frontmatter, body } = splitFrontmatter(text)
    if (frontmatter === null) throw new Error('providers.md has no frontmatter')
    const doc = parseDocument(frontmatter)
    for (const patch of patches) {
      const list = doc.get('providers') as { items: { get(k: string): unknown; set(k: string, v: unknown): void }[] } | undefined
      const entry = list?.items.find((i) => i.get('id') === patch.id)
      if (!entry) throw new Error(`unknown provider: ${patch.id}`)
      if (patch.enabled !== undefined) entry.set('enabled', patch.enabled)
      if (patch.baseUrl !== undefined) entry.set('base_url', patch.baseUrl.trim())
      if (patch.concurrency !== undefined) {
        if (!Number.isInteger(patch.concurrency) || patch.concurrency < 1) throw new Error('concurrency must be a whole number of at least 1')
        entry.set('concurrency', patch.concurrency)
      }
    }
    const next = `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`
    const check = providersSchema.safeParse(doc.toJS())
    if (!check.success) throw new Error(`providers.md would be invalid: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    await atomicWrite(file, next)
  }

  private async setDefaults(patch: Extract<Command, { type: 'setDefaults' }>['patch']): Promise<DefaultsConfig> {
    const file = path.join(this.dataDir, 'config', 'defaults.json')
    const current = await loadDefaults(this.dataDir)
    const next = {
      ...current,
      agentModels: { ...current.agentModels, ...(patch.agentModels ?? {}) },
      defaultMaxChunkTokens: patch.defaultMaxChunkTokens ?? current.defaultMaxChunkTokens
    }
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
    return loadDefaults(this.dataDir)
  }

  private exportRel(out: string): string | null {
    const rel = path.relative(this.dataDir, out)
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/')
  }

  /** Runs one command. Throws on a failure (the transport turns it into an error reply). */
  async handle(cmd: Command): Promise<unknown> {
    const s = this.service
    switch (cmd.type) {
      case 'getInfo':
        return this.info()
      case 'snapshot':
        await s.snapshot()
        return undefined
      case 'listModels':
        return this.modelsInfo()
      case 'refreshModels':
        await this.registry.load()
        return this.discover()
      case 'setSecret': {
        if (![...this.registry.providers.values()].some((p) => p.apiKeyEnv === cmd.name)) throw new Error(`no provider uses the key ${cmd.name}`)
        if (!cmd.value.trim()) throw new Error('the key is empty')
        this.storeKey(cmd.name, cmd.value.trim())
        await this.registry.load()
        return this.modelsInfo()
      }
      case 'saveProviders':
        await this.saveProviders(cmd.providers)
        await this.registry.load()
        return this.modelsInfo()
      case 'getDefaults':
        return loadDefaults(this.dataDir)
      case 'setDefaults':
        return this.setDefaults(cmd.patch)
      case 'createProject': {
        const { type: _type, ...req } = cmd
        return s.createProject(req)
      }
      case 'analyze':
        return this.analyze(cmd)
      case 'getProject':
        return s.detail(cmd.projectId)
      case 'getChunk':
        return s.store.readChunk(cmd.projectId, cmd.index)
      case 'start':
      case 'resume':
        void s.start(cmd.projectId).catch(() => undefined)
        return undefined
      case 'pause':
        await s.pause(cmd.projectId)
        return undefined
      case 'cancel':
        await s.cancel(cmd.projectId)
        return undefined
      case 'retryChunk':
        void s.retryChunk(cmd.projectId, cmd.index, cmd.model).catch(() => undefined)
        return undefined
      case 'editChunk':
        return s.editChunk(cmd.projectId, cmd.index, cmd.final)
      case 'updateGlossary':
        await s.updateGlossary(cmd.projectId, cmd.entries)
        return undefined
      case 'export': {
        const out = await s.export(cmd.projectId, cmd.outPath)
        return { path: out, rel: this.exportRel(out) }
      }
      case 'deleteProject':
        await s.deleteProject(cmd.projectId)
        return undefined
      default: {
        const never: never = cmd
        throw new Error(`unknown command: ${(never as { type?: string }).type}`)
      }
    }
  }
}

/** Connects a transport to a dispatcher: every request gets a `reply` event with the result or the error message. */
export function serveEngine(transport: EngineTransport, dispatcher: CommandDispatcher): () => void {
  return transport.onMessage((msg) => {
    if (!isRequest(msg)) return
    dispatcher.handle(msg.command).then(
      (result) => transport.send({ type: 'reply', id: msg.id, ok: true, result }),
      (err: unknown) => transport.send({ type: 'reply', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
  })
}
