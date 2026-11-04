import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMdWith } from '../../shared/md'
import { defaultsSchema, modelsConfigSchema, providersSchema } from '../../shared/schemas'
import type { DefaultsConfig, ModelsConfig, ProviderEntry } from '../../shared/schemas'
import { promises as fs } from 'node:fs'
import { AnthropicClient } from './anthropic'
import { ClientProvider, ClientTaskQueue } from './client'
import { GeminiClient } from './gemini'
import { resolveKey } from './keys'
import type { KeyResolver } from './keys'
import { MockProvider } from './mock'
import { OpenAiCompatClient } from './openaiCompat'
import type { ListedModel } from './openaiCompat'
import type { ProviderClient } from './types'

export interface ProviderInfo {
  id: string
  kind: ProviderEntry['kind']
  /** Label for the UI (`name` in providers.md, else the id). */
  name: string
  /** Added in the Models dialog: its own group, editable and removable there. */
  custom: boolean
  enabled: boolean
  local: boolean
  baseUrl?: string
  apiKeyEnv?: string
  concurrency: number
  /** `concurrency: auto`: `concurrency` follows the server's own slot count (see `syncServerSlots`). */
  concurrencyAuto: boolean
  /** `concurrency: auto`: the server did not answer the last check, or says its model is unloaded and won't load on request. Work skips it while another model is left. */
  down: boolean
  rpm?: number
  /** Requests per day, counted from midnight UTC (see `ProviderLimiter.dayFull`). */
  rpd?: number
  /** `free`: only the models the provider lists at price 0. */
  discover: boolean | 'free'
  /** Words that keep a model out of discovery (`discover_skip`). */
  discoverSkip: string[]
  /** Send the JSON schema as `response_format` (`openai-compat`). */
  jsonSchema: boolean
  /** LM Studio: the engine loads a model that isn't loaded yet, with `lmLoad` (see `setDefaults`). */
  loadModels: boolean
  /** Has `loaded` rows: the model the server runs is asked for (`served`), and the rows follow it. */
  hasLoaded: boolean
  /** `profiles` of providers.md: settings per model the server may run, matched by id prefix. */
  profiles: ProviderEntry['profiles']
  /** The model the server reported last (`/status`, `/models`); kept while it does not answer. Only for a provider with `loaded` rows. */
  served?: string
  /** Enabled and (local, mock or has a key). */
  available: boolean
  unavailableReason?: string
  client?: ProviderClient
}

export interface ModelInfo {
  /** `provider/model`. */
  ref: string
  provider: ProviderInfo
  id: string
  family: string
  /** Context from providers.md. */
  context?: number
  /** Context the model is loaded with (LM Studio). Wins over `context`. */
  loadedContext?: number
  maxOutput?: number
  /** USD per 1M tokens. */
  priceIn: number
  priceOut: number
  priceCachedIn: number
  embedding: boolean
  extraBody: Record<string, unknown> | null
  discovered: boolean
  /** Added from `picked` in config/models.md (the Models dialog), not from providers.md. */
  picked?: boolean
  /** LM Studio: this model's own load settings (`load_context`, `load_parallel`), over the defaults' ones. */
  loadContext?: number
  loadParallel?: number
  /** Send the JSON schema as `response_format` for this model, over the provider's setting. Undefined: the provider's. */
  jsonSchema?: boolean
  /** A `loaded` row: it stands for the model the provider serves. */
  loaded?: boolean
  /** A `loaded` row: the model the provider serves now (undefined until it has answered once). `family`, `context`, `extraBody` follow it. */
  servedId?: string
  /** A `loaded` row: what providers.md says, before the served model's profile is applied. */
  loadedBase?: { family: string; context?: number; maxOutput?: number; extraBody: Record<string, unknown> | null; jsonSchema?: boolean }
}

/** A profile for a served model id: the one with the same id (any case), else the longest id it starts with. */
export function profileFor(profiles: ProviderEntry['profiles'], served: string): ProviderEntry['profiles'][number] | undefined {
  const s = served.toLowerCase()
  const exact = profiles.find((x) => x.id.toLowerCase() === s)
  if (exact) return exact
  let best: ProviderEntry['profiles'][number] | undefined
  for (const x of profiles) if (s.startsWith(x.id.toLowerCase()) && (!best || x.id.length > best.id.length)) best = x
  return best
}

export interface RegistryOptions {
  keys?: KeyResolver
  fetchImpl?: typeof fetch
  /** The queue of the `client` provider. Default: the registry's own; the engine service replaces it with the one it owns. */
  clientQueue?: ClientTaskQueue
  /** Reuse a mock provider so tests can script it. */
  mock?: MockProvider
  /** LM Studio's `lms` command line, used to load models. Default: `~/.lmstudio/bin/lms(.exe)` when it exists. `null`: use the REST API. */
  lmsPath?: string | null
}

function defaultLmsPath(): string | undefined {
  const p = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')
  return existsSync(p) ? p : undefined
}

/** A model that costs money: not local and with a price. */
export function isPaidModel(m: ModelInfo): boolean {
  return !m.provider.local && (m.priceIn > 0 || m.priceOut > 0 || m.priceCachedIn > 0)
}

/** Cost in USD for a usage on a model. Cached input is billed at its own price. */
export function computeCost(m: Pick<ModelInfo, 'priceIn' | 'priceOut' | 'priceCachedIn'>, u: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens)
  return (uncached * m.priceIn + u.cachedInputTokens * m.priceCachedIn + u.outputTokens * m.priceOut) / 1_000_000
}

export const DEFAULT_CONTEXT = 8192

/** The context of Claude Code, the usual client: a `client` model with no `context` of its own or its provider's plans with this. */
export const CLIENT_DEFAULT_CONTEXT = 200_000

/** The fallback list of defaults.json (SCP-19: an open list), and how LM Studio models are loaded. */
export interface ModelDefaults {
  /** `provider/model` refs, first row first. A kind name (`paid`, `strata`, `lmstudio`, `client` ...) stands for the first row of that kind, `<kind>-<n>` for the n-th. */
  fallbacks?: string[]
  /** One fallback order for every role / agent (`fallbackShared`). False: each list keeps its own order. */
  shared?: boolean
  aliases?: Record<string, string>
  order?: string[]
  lmLoad: { parallel: number; context: number; ttlMinutes: number }
}

/** The fallback list, aliases and LM Studio load settings of a defaults.json. */
export function modelDefaultsOf(
  d: Pick<DefaultsConfig, 'groupDefaults' | 'modelOrder' | 'lmstudio'> & Partial<Pick<DefaultsConfig, 'fallbacks' | 'fallbackShared'>> & { fallback_shared?: boolean }
): ModelDefaults & { fallbacks: string[]; shared: boolean } {
  const aliases: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.groupDefaults ?? {})) if (v) aliases[k] = v

  let fallbacks = d.fallbacks
  if (!fallbacks || fallbacks.length === 0) {
    if (d.modelOrder && d.modelOrder.length > 0) {
      fallbacks = d.modelOrder.map((g) => d.groupDefaults?.[g]).filter((x): x is string => Boolean(x))
    }
    if (!fallbacks || fallbacks.length === 0) {
      fallbacks = Object.values(d.groupDefaults ?? {}).filter((x): x is string => Boolean(x))
    }
    if (!fallbacks || fallbacks.length === 0) {
      fallbacks = ['deepseek/deepseek-flash', 'strata/default']
    }
  }

  const shared = d.fallbackShared ?? d.fallback_shared ?? false
  const lm = d.lmstudio ?? { parallel: 4, context: 131072, ttlMinutes: 60 }

  return {
    fallbacks,
    shared,
    aliases,
    order: d.modelOrder,
    lmLoad: { parallel: lm.parallel, context: lm.context, ttlMinutes: lm.ttlMinutes }
  }
}

export class ModelRegistry {
  providers = new Map<string, ProviderInfo>()
  models = new Map<string, ModelInfo>()
  /** config/models.md: the models picked in the Models dialog, the refs the pickers leave out, and the limits. */
  modelChoices: ModelsConfig = { kind: 'models', picked: [], hidden: [], limits: {} }
  /** Counts the successful `load`s: a call that started under an older one takes its models afresh (see `ModelRouter.chat`). */
  generation = 0
  readonly mock: MockProvider
  /** Where `client` providers park their requests (the MCP tools read it). */
  clientQueue: ClientTaskQueue
  /** The slot counts servers reported for `concurrency: auto` providers, kept across config reloads. */
  private serverSlots = new Map<string, number>()
  /** Which of them did not answer the last check, kept across config reloads. */
  private serverDown = new Map<string, boolean>()
  /** The model each provider with `loaded` rows serves, and its context window when `/models` said, kept across config reloads. */
  private servedIds = new Map<string, string>()
  private servedCtx = new Map<string, number>()
  /** `provider/<alias>` of a `loaded` row -> its ref. */
  private aliasRefs = new Map<string, string>()
  /** `configSignature()` of the files the last successful `load` read, for `configChanged`. */
  private configStamp = ''
  /** Until defaults.json is read: the defaults it has when it says nothing. */
  private defaults: ModelDefaults & { fallbacks: string[]; shared: boolean } = modelDefaultsOf(defaultsSchema.parse({}))

  constructor(
    private readonly dataDir: string,
    private readonly opts: RegistryOptions = {}
  ) {
    this.mock = opts.mock ?? new MockProvider('mock')
    this.clientQueue = opts.clientQueue ?? new ClientTaskQueue()
  }

  /** Uses this queue for every `client` provider, now and after a reload. */
  setClientQueue(queue: ClientTaskQueue): void {
    this.clientQueue = queue
    for (const p of this.providers.values()) if (p.client instanceof ClientProvider) p.client.queue = queue
  }

  /** Size and modification time of the files a load reads (providers.md, models.md, defaults.json), as one string. */
  async configSignature(): Promise<string> {
    const parts: string[] = []
    for (const name of ['providers.md', 'models.md', 'defaults.json']) {
      try {
        const st = await fs.stat(path.join(this.dataDir, 'config', name))
        parts.push(`${st.mtimeMs}:${st.size}`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        parts.push('missing')
      }
    }
    return parts.join('|')
  }

  /** True when a config file changed on disk since the last successful `load` (or since `markConfigSeen`). */
  async configChanged(): Promise<boolean> {
    return (await this.configSignature()) !== this.configStamp
  }

  /** Treats the files with this signature as seen, so a file that can't be read is not tried again until it changes. */
  markConfigSeen(signature: string): void {
    this.configStamp = signature
  }

  /** (Re)reads config/providers.md and config/models.md. Keeps the previous state if a file is invalid. */
  async load(): Promise<void> {
    // taken before the files are read: an edit during the read shows as a change at the next check
    const signature = await this.configSignature()
    const provFile = path.join(this.dataDir, 'config', 'providers.md')
    const prov = parseMdWith(await fs.readFile(provFile, 'utf8'), providersSchema, provFile)
    const choices = await this.readModelChoices()
    const keys = this.opts.keys ?? resolveKey
    const discoveredBefore = [...this.models.values()].filter((m) => m.discovered)
    const loadedBefore = new Map([...this.models.values()].filter((m) => m.loadedContext !== undefined).map((m) => [m.ref, m.loadedContext!]))

    const providers = new Map<string, ProviderInfo>()
    const models = new Map<string, ModelInfo>()
    const aliasRefs = new Map<string, string>()
    for (const p of prov.data.providers) {
      // limits set in the Models dialog (config/models.md) win over providers.md; 0 there means no limit
      const set = choices.limits[p.id] ?? {}
      const limit = (v: number | undefined, fallback: number | undefined) => (v === undefined ? fallback : v > 0 ? v : undefined)
      const info: ProviderInfo = {
        id: p.id,
        name: p.name?.trim() || p.id,
        custom: p.custom,
        kind: p.kind,
        enabled: p.enabled,
        local: p.local || p.kind === 'client', // answered by an MCP client: no key, never paid
        baseUrl: p.base_url,
        apiKeyEnv: p.api_key_env,
        concurrency: p.concurrency === 'auto' ? (this.serverSlots.get(p.id) ?? 1) : (set.concurrency ?? p.concurrency),
        concurrencyAuto: p.concurrency === 'auto',
        down: p.concurrency === 'auto' ? (this.serverDown.get(p.id) ?? false) : false,
        rpm: limit(set.rpm, p.rpm),
        rpd: limit(set.rpd, p.rpd),
        discover: p.discover,
        discoverSkip: p.discover_skip,
        jsonSchema: p.json_schema,
        loadModels: p.load_models,
        hasLoaded: p.kind === 'openai-compat' && p.models.some((m) => m.loaded),
        profiles: p.profiles,
        served: this.servedIds.get(p.id),
        available: false
      }
      this.setupClient(info, keys)
      providers.set(p.id, info)
      for (const m of p.models) {
        const ref = `${p.id}/${m.id}`
        const ctx = m.context ?? p.context ?? (p.kind === 'client' ? CLIENT_DEFAULT_CONTEXT : undefined)
        models.set(ref, {
          ref,
          provider: info,
          id: m.id,
          family: m.family,
          // a model the engine loads itself gets the context window it loads it with
          context: p.load_models ? Math.min(ctx ?? Infinity, m.load_context ?? this.defaults.lmLoad.context) : ctx,
          loadContext: m.load_context,
          loadParallel: m.load_parallel,
          maxOutput: m.max_output,
          priceIn: m.price_in,
          priceOut: m.price_out,
          priceCachedIn: m.price_cached_in ?? m.price_in,
          embedding: m.embedding,
          extraBody: m.extra_body ?? null,
          jsonSchema: m.json_schema,
          discovered: false
        })
        const row = models.get(ref)!
        if (m.loaded && info.hasLoaded) {
          row.loaded = true
          row.loadedBase = { family: m.family, context: row.context, maxOutput: m.max_output, extraBody: m.extra_body ?? null, jsonSchema: m.json_schema }
          this.applyServed(row)
          for (const a of m.aliases) aliasRefs.set(`${p.id}/${a}`, ref)
        }
      }
    }
    for (const a of [...aliasRefs.keys()]) if (models.has(a)) aliasRefs.delete(a) // a real row with that id wins
    this.aliasRefs = aliasRefs
    this.providers = providers
    this.models = models
    this.modelChoices = choices
    // models picked in the Models dialog, with the price the provider listed then; providers.md wins for a model in both
    for (const m of choices.picked) {
      const p = providers.get(m.provider)
      const ref = `${m.provider}/${m.id}`
      if (!p || models.has(ref) || p.hasLoaded) continue // a provider with `loaded` rows adds no models
      models.set(ref, {
        ref,
        provider: p,
        id: m.id,
        family: m.family === 'unknown' ? guessFamily(m.id) : m.family,
        context: m.context,
        maxOutput: m.max_output,
        priceIn: m.price_in,
        priceOut: m.price_out,
        priceCachedIn: m.price_cached_in ?? m.price_in,
        embedding: m.embedding,
        extraBody: m.extra_body ?? null,
        jsonSchema: m.json_schema,
        discovered: false,
        picked: true
      })
    }
    // Keep what discovery found earlier, so a config reload does not forget it.
    for (const d of discoveredBefore) {
      const prov = this.providers.get(d.provider.id)
      if (prov && !this.models.has(d.ref) && !skipsDiscovered(prov, d.id)) this.models.set(d.ref, { ...d, provider: prov })
    }
    for (const [ref, loaded] of loadedBefore) {
      const m = this.models.get(ref)
      if (m) m.loadedContext = loaded // what LM Studio reported stays true after a reload
    }
    this.configStamp = signature
    this.generation++
  }

  modelsFile(): string {
    return path.join(this.dataDir, 'config', 'models.md')
  }

  /** config/models.md, or nothing picked or hidden when it is missing. An invalid file throws, so `load` keeps the previous state. */
  private async readModelChoices(): Promise<ModelsConfig> {
    let text: string
    try {
      text = await fs.readFile(this.modelsFile(), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'models', picked: [], hidden: [], limits: {} }
      throw err
    }
    return parseMdWith(text, modelsConfigSchema, this.modelsFile()).data
  }

  /** The pickers offer this model (it is not in `hidden` of config/models.md). */
  isShown(ref: string): boolean {
    return !this.modelChoices.hidden.includes(ref)
  }

  /** `GET /models` on a server that is not in providers.md (yet): how many models it lists. Throws with the reason when it can't be asked. */
  async testEndpoint(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<number> {
    const client = new OpenAiCompatClient({ id: 'test', baseUrl, apiKey, fetchImpl: this.opts.fetchImpl })
    return (await client.listModelInfo(signal)).length
  }

  /** Every chat model a provider lists (`GET /models`), whether it is in the pickers or not, for the Models dialog. */
  async catalog(providerId: string, signal?: AbortSignal): Promise<ListedModel[]> {
    const p = this.providers.get(providerId)
    if (!p) throw new Error(`no provider "${providerId}"`)
    if (!p.available) throw new Error(p.unavailableReason ?? 'not available')
    if (!(p.client instanceof OpenAiCompatClient)) throw new Error(`a ${p.kind} provider can't list its models here: add them to providers.md`)
    if (p.hasLoaded) {
      // its `loaded` rows stand for whatever it runs: asking only tells which model that is
      this.noteServed(p, await p.client.listModelInfo(signal))
      return []
    }
    return (await p.client.listModelInfo(signal)).filter((m) => m.textOnly && !/embed/i.test(m.id) && !skipsDiscovered(p, m.id))
  }

  private setupClient(info: ProviderInfo, keys: KeyResolver): void {
    if (!info.enabled) {
      info.unavailableReason = 'disabled in config/providers.md'
      return
    }
    if (info.kind === 'mock') {
      info.client = this.mock
      info.available = true
      return
    }
    if (info.kind === 'client') {
      info.client = new ClientProvider(info.id, this.clientQueue)
      info.available = true
      return
    }
    let apiKey: string | undefined
    if (info.apiKeyEnv) {
      apiKey = keys(info.apiKeyEnv)
      if (!apiKey && !info.local) {
        info.unavailableReason = `no key (set ${info.apiKeyEnv} or run: npm run key:set ${info.apiKeyEnv})`
        return
      }
    }
    const fetchImpl = this.opts.fetchImpl
    if (info.kind === 'openai-compat') {
      if (!info.baseUrl) {
        info.unavailableReason = 'no base_url'
        return
      }
      info.client = new OpenAiCompatClient({
        id: info.id,
        baseUrl: info.baseUrl,
        apiKey,
        fetchImpl,
        jsonSchema: info.jsonSchema,
        loadConfig: info.loadModels ? (model) => this.loadConfigFor(info.id, model) : undefined,
        lmsPath: info.loadModels ? (this.opts.lmsPath === null ? undefined : (this.opts.lmsPath ?? defaultLmsPath())) : undefined
      })
    } else if (info.kind === 'anthropic') {
      info.client = new AnthropicClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    } else if (info.kind === 'gemini') {
      info.client = new GeminiClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    }
    info.available = true
  }

  /**
   * `GET /models` on every provider with `discover` set. Adds unknown models, family guessed from the id.
   * A paid provider's model is only added with the price the provider lists (`discover: free`: only at price 0), so the cost is known.
   */
  async discover(signal?: AbortSignal): Promise<{ provider: string; found: number; served?: string; error?: string }[]> {
    const out: { provider: string; found: number; served?: string; error?: string }[] = []
    for (const p of this.providers.values()) {
      if (!p.discover || !p.available || !(p.client instanceof OpenAiCompatClient)) continue
      try {
        const listed = await p.client.listModelInfo(signal)
        if (p.hasLoaded) {
          // the `loaded` rows stand for the served model: discovery only finds out which one it is
          this.noteServed(p, listed)
          out.push({ provider: p.id, found: 0, served: p.served })
          continue
        }
        const ctxLen = p.local ? await p.client.contextLengths(signal) : new Map<string, number>() // LM Studio's loaded windows
        let found = 0
        for (const m of listed) {
          const ref = `${p.id}/${m.id}`
          if (skipsDiscovered(p, m.id) || !m.textOnly) continue
          const free = !!m.price && m.price.in === 0 && m.price.out === 0
          if (p.discover === 'free' ? !free : !p.local && !m.price) continue
          found++
          if (this.models.has(ref)) continue
          this.models.set(ref, {
            ref,
            provider: p,
            id: m.id,
            family: guessFamily(m.id),
            context: m.context,
            maxOutput: m.maxOutput,
            priceIn: p.local ? 0 : (m.price?.in ?? 0),
            priceOut: p.local ? 0 : (m.price?.out ?? 0),
            priceCachedIn: p.local ? 0 : (m.price?.cachedIn ?? m.price?.in ?? 0),
            embedding: /embed/i.test(m.id),
            extraBody: null,
            discovered: true
          })
        }
        // the context the model is loaded with, unless providers.md says otherwise (a model already loaded counts as it is)
        for (const [id, len] of ctxLen) {
          const m = this.models.get(`${p.id}/${id}`)
          if (!m) continue
          if (p.loadModels) m.context = len
          else m.loadedContext = len
        }
        out.push({ provider: p.id, found })
      } catch (err) {
        out.push({ provider: p.id, found: 0, error: (err as Error).message })
      }
    }
    return out
  }

  /**
   * Asks every `concurrency: auto` provider how many requests it serves at once and sets its `concurrency`:
   * Strata reports it as `concurrency.serving` of `GET <base_url>/status`; for LM Studio it is the sum of `parallel`
   * over the loaded chat models (`GET /api/v1/models`, set with `lms load --parallel <n>`).
   * A server that can't be asked counts as 1 and is marked `down`, as is a Strata whose model is unloaded without `auto_load`.
   * A provider with `loaded` rows also reports its model there (`model`); the rows follow it.
   * Returns the providers whose concurrency changed (`slots`) and the ones whose served model changed (`served`).
   */
  async syncServerSlots(signal?: AbortSignal): Promise<{ slots: { provider: ProviderInfo; from: number; to: number }[]; served: { provider: ProviderInfo; from?: string; to: string }[] }> {
    const changed: { provider: ProviderInfo; from: number; to: number }[] = []
    const served: { provider: ProviderInfo; from?: string; to: string }[] = []
    for (const p of this.providers.values()) {
      if (!p.concurrencyAuto || !p.available || !p.baseUrl) continue
      const base = p.baseUrl.replace(/\/+$/, '')
      let answered = false
      let unloaded = false
      const get = async (url: string) => {
        const res = await (this.opts.fetchImpl ?? fetch)(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) })
        answered = true
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null
      }
      let slots = 1
      try {
        const status = await get(`${base}/status`).catch(() => null)
        unloaded = status?.loaded === false && status?.auto_load !== true
        if (p.hasLoaded && typeof status?.model === 'string' && status.model) {
          const c = this.setServed(p, status.model)
          if (c) served.push(c)
        }
        const n = Number((status?.concurrency as { serving?: unknown } | undefined)?.serving)
        if (Number.isInteger(n) && n >= 1) slots = Math.min(n, 16)
        else {
          // LM Studio: its native API sits next to the OpenAI-compatible /v1
          const lm = await get(`${base.replace(/\/v1$/, '')}/api/v1/models`)
          const models = (lm?.models ?? []) as { type?: string; loaded_instances?: { config?: { parallel?: unknown } }[] }[]
          let sum = 0
          for (const m of models) {
            if (m.type !== 'llm') continue
            for (const i of m.loaded_instances ?? []) {
              const par = Number(i.config?.parallel)
              sum += Number.isInteger(par) && par >= 1 ? par : 1
            }
          }
          if (sum >= 1) slots = Math.min(sum, 16)
        }
      } catch {
        /* the server is down or restarting: one at a time until it answers */
      }
      this.serverSlots.set(p.id, slots)
      p.down = !answered || unloaded
      this.serverDown.set(p.id, p.down)
      if (p.concurrency !== slots) {
        changed.push({ provider: p, from: p.concurrency, to: slots })
        p.concurrency = slots
      }
    }
    return { slots: changed, served }
  }

  /** The model a provider with `loaded` rows serves: the first entry of `GET /models` that is no alias (`alias_of`), and its `meta.n_ctx`. No such entry (nothing loaded): nothing changes. */
  private noteServed(p: ProviderInfo, listed: ListedModel[]): void {
    const first = listed.find((m) => !m.aliasOf)
    if (!first) return
    this.setServed(p, first.id, first.nCtx)
  }

  /** Records the served model of `p` and re-applies its profile to the `loaded` rows in place. Returns the change, or null when it is the same model. */
  private setServed(p: ProviderInfo, id: string, nCtx?: number): { provider: ProviderInfo; from?: string; to: string } | null {
    const from = this.servedIds.get(p.id)
    if (from !== id) this.servedCtx.delete(p.id)
    if (nCtx) this.servedCtx.set(p.id, nCtx)
    this.servedIds.set(p.id, id)
    p.served = id
    for (const m of this.models.values()) if (m.provider.id === p.id && m.loadedBase) this.applyServed(m)
    return from === id ? null : { provider: p, from, to: id }
  }

  /** Sets a `loaded` row's family, context, `extra_body` and JSON schema flag from the served model's profile (HUB-26 plan, C1.2 rule 3). */
  private applyServed(m: ModelInfo): void {
    const b = m.loadedBase
    if (!b) return
    const served = this.servedIds.get(m.provider.id)
    const k = served ? profileFor(m.provider.profiles, served) : undefined
    m.servedId = served
    m.family = served ? (k?.family ?? guessFamily(served)) : b.family
    m.context = served ? (k?.context ?? this.servedCtx.get(m.provider.id) ?? b.context) : b.context
    m.maxOutput = served ? (k?.max_output ?? b.maxOutput) : b.maxOutput
    const body = { ...(served ? k?.extra_body : undefined), ...b.extraBody }
    m.extraBody = Object.keys(body).length ? body : null
    m.jsonSchema = b.jsonSchema ?? (served ? k?.json_schema : undefined) ?? m.provider.jsonSchema
  }

  /** Marks a `concurrency: auto` server down at once (a request could not reach it), for every project. True when that is news. */
  markDown(p: ProviderInfo): boolean {
    if (!p.concurrencyAuto || p.down) return false
    p.down = true
    this.serverDown.set(p.id, true)
    return true
  }

  /** A model by its ref; an older ref of a `loaded` row (`strata/qwen3.8-flash-next`) finds the row. */
  getModel(ref: string): ModelInfo | undefined {
    return this.models.get(ref) ?? this.models.get(this.aliasRefs.get(ref) ?? '')
  }

  /** The context window to plan with: LM Studio's loaded context, else `context` of the model or its provider in providers.md (200000 for a `client` provider), else 8192. */
  contextLength(ref: string): number {
    const m = this.getModel(ref)
    return m?.loadedContext ?? m?.context ?? DEFAULT_CONTEXT
  }

  /** How a `load_models` provider loads `model`: the defaults, with the model's own `load_context` / `load_parallel` over them. */
  loadConfigFor(provider: string, model: string): ModelDefaults['lmLoad'] {
    const m = this.models.get(`${provider}/${model}`)
    const d = this.defaults.lmLoad
    return { parallel: m?.loadParallel ?? d.parallel, context: m?.loadContext ?? d.context, ttlMinutes: d.ttlMinutes }
  }

  /** Sets the fallback list and the LM Studio load settings. Call `load()` after it so model context windows follow. */
  setDefaults(d: ModelDefaults): void {
    let fallbacks = d.fallbacks
    if (!fallbacks || fallbacks.length === 0) {
      if (d.order && d.order.length > 0) {
        fallbacks = d.order.map((g) => d.aliases?.[g]).filter((x): x is string => Boolean(x))
      }
      if (!fallbacks || fallbacks.length === 0) {
        fallbacks = Object.values(d.aliases ?? {}).filter((x): x is string => Boolean(x))
      }
      if (!fallbacks || fallbacks.length === 0) {
        fallbacks = ['deepseek/deepseek-flash', 'strata/default']
      }
    }
    this.defaults = {
      ...d,
      fallbacks,
      shared: d.shared ?? false
    }
  }

  /** The fallback list, first row first. */
  fallbackRefs(): string[] {
    return this.defaults.fallbacks
  }

  /** The kind of a row or model, by its provider: the provider's id for a local or custom one (a client too), `paid` for an API provider or one that providers.md does not have. */
  private kindOfRef(ref: string): string {
    const p = this.providers.get(ref.split('/')[0]!)
    return p?.local || p?.custom ? p.id : 'paid'
  }

  /** The kind of an alias or a `provider/model`: `paid` for every API model, otherwise the provider's id. */
  kindOf(ref: string): string {
    return this.kindOfRef(this.resolve(ref))
  }

  /** What each alias stands for: a kind name is its first row, `<kind>-<n>` its n-th. */
  aliasMap(): Map<string, string> {
    const map = new Map<string, string>()
    const count = new Map<string, number>()
    for (const ref of this.defaults.fallbacks) {
      const kind = this.kindOfRef(ref)
      const n = (count.get(kind) ?? 0) + 1
      count.set(kind, n)
      if (n === 1) map.set(kind, ref)
      map.set(`${kind}-${n}`, ref)
    }
    return map
  }

  /** A `provider/model`, or an alias (`paid`, `paid-2`, `strata`, `lmstudio` ...) resolved to its row. An alias with no row stays as it is. */
  resolve(ref: string): string {
    if (ref.includes('/')) return this.models.has(ref) ? ref : (this.aliasRefs.get(ref) ?? ref)
    return this.aliasMap().get(ref) ?? this.defaults.aliases?.[ref] ?? ref
  }

  unresolvedAliases(): string[] {
    const map = this.aliasMap()
    const out = new Set<string>()
    for (const list of Object.values(this.defaults.aliases ?? {})) {
      if (!list.includes('/') && !map.has(list)) out.add(list)
    }
    return [...out]
  }

  /**
   * Sorts a list of refs. Without `fallbackShared` it keeps its order, aliases kept. With it, every row of the fallback list in its order, except that
   * a concrete model the list names takes the place of the first row of its kind not taken yet (a model that is itself a row keeps it; an alias
   * of the row it replaced is dropped); a model with no row of its kind, and the other aliases, follow in the list's own order, duplicates dropped. A client model goes first.
   */
  orderRefs(list: readonly string[]): string[] {
    if (!this.defaults.shared) {
      const order = this.defaults.order ?? []
      if (order.length === 0) return [...list]
      const rank = (ref: string) => {
        if (this.providers.get(this.resolve(ref).split('/')[0]!)?.kind === 'client') return -1
        const g = this.groupOf(ref)
        const i = g ? order.indexOf(g) : -1
        return i < 0 ? order.length : i
      }
      return list.map((ref, i) => ({ ref, i, r: rank(ref) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.ref)
    }
    const rows = [...this.defaults.fallbacks]
    const taken = new Set<number>()
    const isClient = (ref: string) => this.providers.get(this.resolve(ref).split('/')[0]!)?.kind === 'client'
    const placed = new Set<string>()
    const replaced = new Set<string>() // rows a role's own model took the place of
    for (const c of list) {
      if (!c.includes('/') || isClient(c)) continue
      const same = rows.findIndex((r, i) => r === c && !taken.has(i))
      const kind = this.kindOfRef(c)
      const at = same >= 0 ? same : rows.findIndex((r, i) => !taken.has(i) && this.kindOfRef(r) === kind)
      if (at < 0) continue
      if (rows[at] !== c) replaced.add(rows[at]!)
      rows[at] = c
      taken.add(at)
      placed.add(c)
    }
    const out: string[] = []
    const seen = new Set<string>()
    const add = (ref: string) => {
      const r = this.resolve(ref)
      if (seen.has(r)) return
      seen.add(r)
      out.push(r)
    }
    for (const c of list) if (isClient(c)) add(c)
    for (const r of rows) add(r)
    for (const c of list) if (!placed.has(c) && !replaced.has(this.resolve(c))) add(c)
    return out
  }

  /** The group of an alias or a `provider/model`: `paid` for an API provider, else the provider id (`strata`, `lmstudio`, a custom provider). Undefined for the `client` and `mock` providers and an unknown one. */
  groupOf(ref: string): string | undefined {
    const provider = this.resolve(ref).split('/')[0]!
    const p = this.providers.get(provider)
    if (p) return p.kind === 'client' || p.kind === 'mock' ? undefined : !p.local && !p.custom ? 'paid' : p.id
    return provider === 'strata' || provider === 'lmstudio' ? provider : undefined
  }

  /** Chat models that can be used right now (provider available, not an embedding model), in registry order. */
  usableModels(): ModelInfo[] {
    return [...this.models.values()].filter((m) => m.provider.available && m.provider.client && !m.embedding)
  }
}

/** A model the server lists but `discover_skip` keeps out (a word of it is in the id, any case). */
function skipsDiscovered(p: ProviderInfo, id: string): boolean {
  const s = id.toLowerCase()
  return p.discoverSkip.some((w) => w && s.includes(w.toLowerCase()))
}

export function guessFamily(id: string): string {
  const s = id.toLowerCase()
  for (const f of ['qwen', 'nemotron', 'poolside', 'laguna', 'deepseek', 'llama', 'mistral', 'gemma', 'gemini', 'claude', 'gpt', 'grok', 'nomic', 'glm', 'kimi']) {
    if (s.includes(f)) return f === 'laguna' ? 'poolside' : f
  }
  // OpenRouter ids start with the maker (`thinkingmachines/inkling:free`): the closest thing to a family
  return s.includes('/') ? s.slice(0, s.indexOf('/')) : 'unknown'
}
