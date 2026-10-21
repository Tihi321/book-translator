import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { applyModelDefaults, loadDefaults } from './config'
import { adapterFor, supportedExtensions } from './formats'
import { resolveKey, setStoredKey } from './models/keys'
import type { KeyResolver } from './models/keys'
import type { ListedModel } from './models/openaiCompat'
import { clientTaskResult } from './models/client'
import { guessFamily } from './models/registry'
import type { ModelRegistry } from './models/registry'
import { mergeSettings } from './project/store'
import { EngineService } from './service'
import { atomicWrite } from './store/atomic'
import { countTokens } from './tokens'
import { parseMd, serializeMd, splitFrontmatter } from '../shared/md'
import type { DocumentIR } from '../shared/ir'
import { defaultsSchema, providersSchema } from '../shared/schemas'
import type { DefaultsConfig } from '../shared/schemas'
import type { AnalyzeResult, CatalogResult, Command, EngineEvent, EngineInfo, EngineTransport, FileInfo, McpStatus, ModelsInfo, ProviderPatch } from '../shared/protocol'
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
  /** The MCP server's state, for `getMcpStatus`. Without it the answer is `running: false`. */
  mcpStatus?: () => McpStatus
  /** Called after `setDefaults` saved the file, with the defaults from before and after (serve restarts the MCP server when `mcp` changed). */
  onDefaultsSaved?: (before: DefaultsConfig, after: DefaultsConfig) => void | Promise<void>
}

/** How often the `concurrency: auto` servers are asked for their slots. */
export const SLOT_SYNC_MS = 10_000

/** How often config/providers.md, models.md and defaults.json are checked for an edit. */
export const CONFIG_CHECK_MS = 3000

/** The commands that check the config files for an edit first (the others wait for the timer). */
const RELOADS_CONFIG = new Set<Command['type']>(['listModels', 'analyze', 'createProject', 'start', 'resume', 'retryChunk'])

/** The body of a config/models.md the app creates. */
const MODELS_MD_BODY = `
# Models in the pickers

Which models the model pickers offer. The app writes this file from the **Models** dialog in Settings: pick a provider, press **Detect models** to list everything it has, and tick the models you want, or add one by its id (with its price for a paid provider). You can also edit it by hand.

- \`picked\`: models that are not in \`providers.md\`, ticked from a provider's list or added by id, each with its \`provider\`, \`id\`, \`context\` and the price the provider listed when you picked it (or the one you typed) (\`price_in\`, \`price_out\`, \`price_cached_in\`, USD per 1M tokens). The cost estimate uses that price.
- \`hidden\`: \`provider/model\` refs the pickers leave out: models from \`providers.md\` or found by \`discover\` that you unticked.
- \`limits\`: per provider, the limits set in the Models dialog, over the ones in \`providers.md\`: \`concurrency\` (requests at once), \`rpm\` (per minute) and \`rpd\` (per day, from midnight UTC). 0 means no limit.
`

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
  /** The last model list each provider gave `detectModels`, for the prices of the models picked from it. */
  private readonly catalogs = new Map<string, ListedModel[]>()
  /** The check that is running, so two callers share one reload. */
  private reloading?: Promise<boolean>

  constructor(private readonly opts: DispatcherOptions) {
    this.service = opts.service
    this.keys = opts.keys ?? resolveKey
    this.storeKey = opts.storeKey ?? setStoredKey
    // a request that finds a server down, or a provider's daily limit used up, tells the UI
    const router = this.service.router
    router.onProviderDown = (p) => {
      this.log('warn', `${p.id} is down (${p.baseUrl} does not answer), requests use the next model in their list until it answers again`)
      this.emitModels()
    }
    router.onProviderDayFull = (p) => {
      this.log('warn', `${p.id} reached its daily limit, requests use the next model in their list until ${new Date(router.limiter.dayResetsAt()).toISOString().slice(11, 16)} UTC`)
      this.emitModels()
    }
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.opts.emit({ type: 'log', level, message: `models: ${message}` })
  }

  private emitModels(): void {
    this.opts.emit({ type: 'models', models: this.modelsInfo() })
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
    const limiter = this.service.router.limiter
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
        concurrencyAuto: p.concurrencyAuto,
        down: p.down,
        rpm: p.rpm,
        rpd: p.rpd,
        requestsToday: limiter.requestsToday(p.id),
        dayFull: limiter.dayFull(p),
        dayResetsAt: limiter.dayResetsAt(),
        loadModels: p.loadModels,
        discover: p.discover,
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
          discovered: m.discovered,
          shown: this.registry.isShown(m.ref),
          picked: m.picked === true,
          maxOutput: m.maxOutput
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
    // a folder's time does not change when a file in it is edited: read it every time
    if (stat.isDirectory()) return adapterFor(abs).read(abs)
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

  /**
   * Asks the `concurrency: auto` servers for their slot count and whether they answer. A higher count frees waiting requests at once.
   * Logs and sends a fresh `models` event when something changed. Used by the 10-second timer in `serve` and by `checkServers`.
   * Returns true when something changed.
   */
  async syncSlots(): Promise<boolean> {
    const wasDown = new Map([...this.registry.providers.values()].map((p) => [p.id, p.down]))
    let changed
    try {
      changed = await this.registry.syncServerSlots()
    } catch (err) {
      this.log('warn', `could not ask the servers for their slots: ${(err as Error).message}`)
      return false
    }
    for (const c of changed) {
      this.log('info', `${c.provider.id} runs ${c.to} request(s) at once (was ${c.from}), as the server reports`)
      if (c.to > c.from) this.service.router.limiter.wakeAll(c.provider)
    }
    // a server that stops answering is skipped (its work goes to the next model in the list) until it answers again
    let upOrDown = false
    for (const p of this.registry.providers.values()) {
      if (!wasDown.has(p.id) || wasDown.get(p.id) === p.down) continue
      upOrDown = true
      this.log(p.down ? 'warn' : 'info', p.down ? `${p.id} is down (${p.baseUrl} does not answer, or has no model loaded), requests use the next model in their list` : `${p.id} answers again`)
    }
    if (changed.length || upOrDown) {
      this.emitModels()
      return true
    }
    return false
  }

  /**
   * Reloads providers and models when providers.md, models.md or defaults.json changed on disk since the last load. Used by the
   * 3-second timer in `serve` and before the commands that plan a run. A file that can't be read keeps the previous providers and is
   * logged once. A project that runs keeps its chunk plan, and a request already waiting for a slot keeps the old provider until it wakes.
   * Returns true when it reloaded.
   */
  reloadConfigIfChanged(): Promise<boolean> {
    this.reloading ??= this.reloadConfig().finally(() => {
      this.reloading = undefined
    })
    return this.reloading
  }

  private async reloadConfig(): Promise<boolean> {
    let signature: string
    try {
      if (!(await this.registry.configChanged())) return false
      signature = await this.registry.configSignature()
    } catch {
      return false
    }
    try {
      await applyModelDefaults(this.registry, this.dataDir)
      await this.registry.load()
    } catch (err) {
      this.registry.markConfigSeen(signature)
      this.log('warn', `config/providers.md (or models.md / defaults.json) could not be read, keeping the previous providers: ${(err as Error).message}`)
      return false
    }
    this.log('info', 'config changed on disk, providers and models reloaded')
    for (const p of this.registry.providers.values()) this.service.router.limiter.wakeAll(p)
    this.emitModels()
    void this.discover().then(() => this.emitModels(), () => undefined)
    return true
  }

  /** Asks a provider for every chat model it lists and keeps the list for `showModels`. Throws when it can't be asked. */
  private async detectModels(provider: string): Promise<CatalogResult> {
    const p = this.registry.providers.get(provider)
    if (!p) throw new Error(`no provider "${provider}"`)
    const listed = await this.registry.catalog(provider)
    this.catalogs.set(provider, listed)
    this.log('info', `${provider} lists ${listed.length} chat model(s)`)
    return {
      provider,
      at: new Date().toISOString(),
      models: listed.map((m) => ({
        id: m.id,
        ref: `${provider}/${m.id}`,
        context: m.context,
        priceIn: p.local ? 0 : m.price?.in,
        priceOut: p.local ? 0 : m.price?.out,
        pickable: p.local || !!m.price
      }))
    }
  }

  /** Reads `picked`, `hidden` and `limits` of config/models.md, lets `change` edit them, writes the file (keeping its text) and reloads the registry. */
  private async editModelChoices(change: (picked: Record<string, unknown>[], hidden: Set<string>, limits: Record<string, Record<string, number>>) => void): Promise<ModelsInfo> {
    const file = this.registry.modelsFile()
    let doc: { data: Record<string, unknown>; body: string }
    try {
      doc = parseMd(await fs.readFile(file, 'utf8'), file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      doc = { data: { kind: 'models' }, body: MODELS_MD_BODY }
    }
    const picked = Array.isArray(doc.data.picked) ? (doc.data.picked as Record<string, unknown>[]) : []
    const hidden = new Set(Array.isArray(doc.data.hidden) ? (doc.data.hidden as string[]) : [])
    const limits = doc.data.limits && typeof doc.data.limits === 'object' ? (doc.data.limits as Record<string, Record<string, number>>) : {}
    change(picked, hidden, limits)
    await atomicWrite(file, serializeMd({ ...doc.data, kind: 'models', picked, hidden: [...hidden].sort(), limits }, doc.body || MODELS_MD_BODY))
    await this.registry.load()
    return this.modelsInfo()
  }

  /**
   * Shows models in the pickers or hides them. Showing a model the app doesn't know yet adds it to `picked` with the context and price its
   * provider listed (detect first); a paid model without a listed price is refused. Hiding a picked model removes it.
   */
  private showModels(provider: string, refs: string[], show: boolean): Promise<ModelsInfo> {
    const p = this.registry.providers.get(provider)
    if (!p) throw new Error(`no provider "${provider}"`)
    for (const ref of refs) if (!ref.startsWith(`${provider}/`)) throw new Error(`${ref} is not a model of ${provider}`)
    return this.editModelChoices((picked, hidden) => {
      const isPicked = (ref: string) => picked.findIndex((m) => `${String(m.provider)}/${String(m.id)}` === ref)
      for (const ref of new Set(refs)) {
        const id = ref.slice(provider.length + 1)
        if (!show) {
          const i = isPicked(ref)
          if (i >= 0) picked.splice(i, 1)
          else hidden.add(ref)
          continue
        }
        hidden.delete(ref)
        if (this.registry.models.has(ref) || isPicked(ref) >= 0) continue
        const m = this.catalogs.get(provider)?.find((x) => x.id === id)
        if (!m) throw new Error(`${provider} has not listed ${id} (detect its models first)`)
        if (!p.local && !m.price) throw new Error(`${ref} has no listed price, so its cost can't be counted: add it by its id with a price`)
        picked.push({
          provider,
          id,
          family: guessFamily(id),
          ...(m.context ? { context: m.context } : {}),
          ...(m.maxOutput ? { max_output: m.maxOutput } : {}),
          price_in: p.local ? 0 : m.price!.in,
          price_out: p.local ? 0 : m.price!.out,
          ...(!p.local && m.price!.cachedIn !== undefined ? { price_cached_in: m.price!.cachedIn } : {})
        })
      }
    })
  }

  /** Adds a model by its id to `picked`. A paid provider's model needs both prices (USD per 1M tokens, 0 for free); a known model is only shown again. */
  private addModel(cmd: Extract<Command, { type: 'addModel' }>): Promise<ModelsInfo> {
    const id = cmd.id.trim()
    const p = this.registry.providers.get(cmd.provider)
    if (!p) throw new Error(`no provider "${cmd.provider}"`)
    if (!id) throw new Error('the model id is empty')
    const price = (v?: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
    const priceIn = p.local ? 0 : price(cmd.priceIn)
    const priceOut = p.local ? 0 : price(cmd.priceOut)
    if (priceIn === undefined || priceOut === undefined) throw new Error(`${cmd.provider}/${id} needs its price in and out (USD per 1M tokens, 0 for a free model)`)
    const ref = `${cmd.provider}/${id}`
    return this.editModelChoices((picked, hidden) => {
      hidden.delete(ref)
      if (this.registry.models.has(ref) || picked.some((m) => `${String(m.provider)}/${String(m.id)}` === ref)) return
      const context = typeof cmd.context === 'number' && cmd.context > 0 ? Math.round(cmd.context) : undefined
      picked.push({ provider: cmd.provider, id, family: guessFamily(id), ...(context ? { context } : {}), price_in: priceIn, price_out: priceOut })
    })
  }

  /** Sets a provider's limits in `limits` of config/models.md, over providers.md. 0 for `rpm`/`rpd` means no limit. A raised limit frees waiting requests at once. */
  private async setProviderLimits(cmd: Extract<Command, { type: 'setProviderLimits' }>): Promise<ModelsInfo> {
    const p = this.registry.providers.get(cmd.provider)
    if (!p) throw new Error(`no provider "${cmd.provider}"`)
    const count = (v: number | undefined, min: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.round(v) : undefined)
    const set: Record<string, number> = {}
    const concurrency = p.concurrencyAuto ? undefined : count(cmd.concurrency, 1)
    if (concurrency !== undefined) set.concurrency = concurrency
    const rpm = count(cmd.rpm, 0)
    if (rpm !== undefined) set.rpm = rpm
    const rpd = count(cmd.rpd, 0)
    if (rpd !== undefined) set.rpd = rpd
    if (!Object.keys(set).length) return this.modelsInfo()
    const info = await this.editModelChoices((_picked, _hidden, limits) => {
      limits[p.id] = { ...(limits[p.id] ?? {}), ...set }
    })
    this.log('info', `${p.id} limits ${Object.entries(set).map(([k, v]) => `${k} ${v || 'none'}`).join(', ')}`)
    const now = this.registry.providers.get(p.id)
    if (now) {
      // requests already waiting for a slot hold the provider object from before the reload: give it the new limits too
      p.concurrency = now.concurrency
      p.rpm = now.rpm
      p.rpd = now.rpd
      this.service.router.limiter.wakeAll(now)
    }
    return info
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
        if (patch.concurrency !== 'auto' && (!Number.isInteger(patch.concurrency) || patch.concurrency < 1)) throw new Error('concurrency must be a whole number of at least 1, or auto')
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
    const groupDefaults: Record<string, string | undefined> = { ...current.groupDefaults, ...(patch.groupDefaults ?? {}) }
    for (const k of Object.keys(groupDefaults)) if (!groupDefaults[k]?.trim()) delete groupDefaults[k]
    const next = {
      ...current,
      agentModels: { ...current.agentModels, ...(patch.agentModels ?? {}) },
      defaultMaxChunkTokens: patch.defaultMaxChunkTokens ?? current.defaultMaxChunkTokens,
      groupDefaults,
      modelOrder: patch.modelOrder ?? current.modelOrder,
      lmstudio: { ...current.lmstudio, ...(patch.lmstudio ?? {}) },
      parallel: { ...current.parallel, ...(patch.parallel ?? {}) },
      mcp: { ...current.mcp, ...(patch.mcp ?? {}) }
    }
    const check = defaultsSchema.safeParse(next)
    if (!check.success) throw new Error(`defaults would be invalid: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
    const saved = await loadDefaults(this.dataDir)
    // the aliases, the order and the LM Studio load settings follow at once (context windows of models LM Studio loads too)
    await applyModelDefaults(this.registry, this.dataDir)
    await this.registry.load()
    await this.opts.onDefaultsSaved?.(current, saved)
    return saved
  }

  private async mcpStatus(): Promise<McpStatus> {
    if (this.opts.mcpStatus) return this.opts.mcpStatus()
    return { enabled: (await loadDefaults(this.dataDir)).mcp.enabled, running: false }
  }

  private exportRel(out: string): string | null {
    const rel = path.relative(this.dataDir, out)
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/')
  }

  /** Runs one command. Throws on a failure (the transport turns it into an error reply). */
  async handle(cmd: Command): Promise<unknown> {
    const s = this.service
    // a providers.md edit shows before the commands that read the models
    if (RELOADS_CONFIG.has(cmd.type)) await this.reloadConfigIfChanged()
    switch (cmd.type) {
      case 'getInfo':
        return this.info()
      case 'snapshot':
        await s.snapshot()
        return undefined
      case 'listModels':
        return this.modelsInfo()
      case 'refreshModels':
        await applyModelDefaults(this.registry, this.dataDir)
        await this.registry.load()
        return this.discover()
      case 'setSecret': {
        if (![...this.registry.providers.values()].some((p) => p.apiKeyEnv === cmd.name)) throw new Error(`no provider uses the key ${cmd.name}`)
        if (!cmd.value.trim()) throw new Error('the key is empty')
        this.storeKey(cmd.name, cmd.value.trim())
        await this.registry.load()
        // the provider may list models now that it has a key (OpenRouter's free models)
        return this.discover()
      }
      case 'saveProviders':
        await this.saveProviders(cmd.providers)
        await this.registry.load()
        await this.syncSlots()
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
      case 'detectModels':
        return this.detectModels(cmd.provider)
      case 'showModels':
        return this.showModels(cmd.provider, cmd.refs, cmd.show)
      case 'addModel':
        return this.addModel(cmd)
      case 'setProviderLimits':
        return this.setProviderLimits(cmd)
      case 'checkServers':
        await this.syncSlots()
        return this.modelsInfo()
      case 'updateProjectSettings': {
        if (s.isRunning(cmd.projectId)) throw new Error('pause the project before changing its settings')
        const project = await s.store.load(cmd.projectId)
        const namesBefore = project.settings.localizeNames === true
        project.settings = mergeSettings(project.settings, cmd.patch)
        await s.store.save(project)
        // chunks that are translated keep the names they were translated with
        if (project.format === 'vn' && namesBefore !== (project.settings.localizeNames === true) && (await s.store.listChunks(cmd.projectId)).some((c) => c.state === 'done' || c.state === 'flagged')) {
          const message = 'localizeNames changed: chunks translated before keep the names they have, retry them to follow the new setting'
          await s.store.log(cmd.projectId, `warn: ${message}`)
          this.opts.emit({ type: 'log', projectId: cmd.projectId, level: 'warn', message })
        }
        return s.detail(cmd.projectId)
      }
      case 'prepareChunks':
        return s.prepareChunks(cmd.projectId, cmd.maxChunkTokens)
      case 'getTranslationTask':
        return s.translationTask(cmd.projectId, cmd.index)
      case 'submitTranslation':
        return s.submitTranslation(cmd.projectId, cmd.index, { reply: cmd.reply, segments: cmd.segments, model: cmd.model })
      case 'setBrief':
        await s.setBrief(cmd.projectId, cmd.brief)
        return undefined
      case 'getMcpStatus':
        return this.mcpStatus()
      case 'listClientTasks':
        return { ...s.clientQueue.counts(), tasks: s.clientQueue.list() }
      case 'getClientTask': {
        const t = s.clientQueue.lease({ role: cmd.role, project: cmd.project, task: cmd.task })
        return t ? clientTaskResult(t) : { none: true as const, waiting: s.clientQueue.counts().waiting }
      }
      case 'submitClientTask':
        return s.clientQueue.submit(cmd.taskId, cmd.text)
      case 'releaseClientTask':
        return { released: s.clientQueue.release(cmd.taskId) }
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
