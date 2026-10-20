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

/** Group aliases (`paid`, `strata`, `lmstudio`) -> `provider/model`, the group order, and how LM Studio models are loaded. From config/defaults.json. */
export interface ModelDefaults {
  aliases: Record<string, string>
  /** The groups `paid`, `strata`, `lmstudio` in the order every list tries them. Empty: each list keeps its own order. */
  order?: string[]
  lmLoad: { parallel: number; context: number; ttlMinutes: number }
}

/** The aliases, group order and LM Studio load settings of a defaults.json. */
export function modelDefaultsOf(d: Pick<DefaultsConfig, 'groupDefaults' | 'modelOrder' | 'lmstudio'>): ModelDefaults {
  const aliases: Record<string, string> = {}
  for (const [k, v] of Object.entries(d.groupDefaults)) if (v) aliases[k] = v
  return { aliases, order: d.modelOrder, lmLoad: { parallel: d.lmstudio.parallel, context: d.lmstudio.context, ttlMinutes: d.lmstudio.ttlMinutes } }
}

export class ModelRegistry {
  providers = new Map<string, ProviderInfo>()
  models = new Map<string, ModelInfo>()
  /** config/models.md: the models picked in the Models dialog, the refs the pickers leave out, and the limits. */
  modelChoices: ModelsConfig = { kind: 'models', picked: [], hidden: [], limits: {} }
  readonly mock: MockProvider
  /** Where `client` providers park their requests (the MCP tools read it). */
  clientQueue: ClientTaskQueue
  /** The slot counts servers reported for `concurrency: auto` providers, kept across config reloads. */
  private serverSlots = new Map<string, number>()
  /** Which of them did not answer the last check, kept across config reloads. */
  private serverDown = new Map<string, boolean>()
  /** Until defaults.json is read: the defaults it has when it says nothing. */
  private defaults: ModelDefaults = modelDefaultsOf(defaultsSchema.parse({}))

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

  /** (Re)reads config/providers.md and config/models.md. Keeps the previous state if a file is invalid. */
  async load(): Promise<void> {
    const provFile = path.join(this.dataDir, 'config', 'providers.md')
    const prov = parseMdWith(await fs.readFile(provFile, 'utf8'), providersSchema, provFile)
    const choices = await this.readModelChoices()
    const keys = this.opts.keys ?? resolveKey
    const discoveredBefore = [...this.models.values()].filter((m) => m.discovered)

    const providers = new Map<string, ProviderInfo>()
    const models = new Map<string, ModelInfo>()
    for (const p of prov.data.providers) {
      // limits set in the Models dialog (config/models.md) win over providers.md; 0 there means no limit
      const set = choices.limits[p.id] ?? {}
      const limit = (v: number | undefined, fallback: number | undefined) => (v === undefined ? fallback : v > 0 ? v : undefined)
      const info: ProviderInfo = {
        id: p.id,
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
        available: false
      }
      this.setupClient(info, keys)
      providers.set(p.id, info)
      for (const m of p.models) {
        const ref = `${p.id}/${m.id}`
        models.set(ref, {
          ref,
          provider: info,
          id: m.id,
          family: m.family,
          // a model the engine loads itself gets the context window it loads it with
          context: p.load_models ? Math.min(m.context ?? Infinity, m.load_context ?? this.defaults.lmLoad.context) : m.context,
          loadContext: m.load_context,
          loadParallel: m.load_parallel,
          maxOutput: m.max_output,
          priceIn: m.price_in,
          priceOut: m.price_out,
          priceCachedIn: m.price_cached_in ?? m.price_in,
          embedding: m.embedding,
          extraBody: m.extra_body ?? null,
          discovered: false
        })
      }
    }
    this.providers = providers
    this.models = models
    this.modelChoices = choices
    // models picked in the Models dialog, with the price the provider listed then; providers.md wins for a model in both
    for (const m of choices.picked) {
      const p = providers.get(m.provider)
      const ref = `${m.provider}/${m.id}`
      if (!p || models.has(ref)) continue
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
        discovered: false,
        picked: true
      })
    }
    // Keep what discovery found earlier, so a config reload does not forget it.
    for (const d of discoveredBefore) {
      const prov = this.providers.get(d.provider.id)
      if (prov && !this.models.has(d.ref) && !skipsDiscovered(prov, d.id)) this.models.set(d.ref, { ...d, provider: prov })
    }
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

  /** Every chat model a provider lists (`GET /models`), whether it is in the pickers or not, for the Models dialog. */
  async catalog(providerId: string, signal?: AbortSignal): Promise<ListedModel[]> {
    const p = this.providers.get(providerId)
    if (!p) throw new Error(`no provider "${providerId}"`)
    if (!p.available) throw new Error(p.unavailableReason ?? 'not available')
    if (!(p.client instanceof OpenAiCompatClient)) throw new Error(`a ${p.kind} provider can't list its models here: add them to providers.md`)
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
  async discover(signal?: AbortSignal): Promise<{ provider: string; found: number; error?: string }[]> {
    const out: { provider: string; found: number; error?: string }[] = []
    for (const p of this.providers.values()) {
      if (!p.discover || !p.available || !(p.client instanceof OpenAiCompatClient)) continue
      try {
        const listed = await p.client.listModelInfo(signal)
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
   * Returns the providers whose concurrency changed.
   */
  async syncServerSlots(signal?: AbortSignal): Promise<{ provider: ProviderInfo; from: number; to: number }[]> {
    const changed: { provider: ProviderInfo; from: number; to: number }[] = []
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
    return changed
  }

  /** Marks a `concurrency: auto` server down at once (a request could not reach it), for every project. True when that is news. */
  markDown(p: ProviderInfo): boolean {
    if (!p.concurrencyAuto || p.down) return false
    p.down = true
    this.serverDown.set(p.id, true)
    return true
  }

  getModel(ref: string): ModelInfo | undefined {
    return this.models.get(ref)
  }

  /** The context window to plan with: LM Studio's loaded context, else `context` in providers.md, else 8192. */
  contextLength(ref: string): number {
    const m = this.models.get(ref)
    return m?.loadedContext ?? m?.context ?? DEFAULT_CONTEXT
  }

  /** How a `load_models` provider loads `model`: the defaults, with the model's own `load_context` / `load_parallel` over them. */
  loadConfigFor(provider: string, model: string): ModelDefaults['lmLoad'] {
    const m = this.models.get(`${provider}/${model}`)
    const d = this.defaults.lmLoad
    return { parallel: m?.loadParallel ?? d.parallel, context: m?.loadContext ?? d.context, ttlMinutes: d.ttlMinutes }
  }

  /** Sets the group aliases, the group order and the LM Studio load settings. Call `load()` after it so model context windows follow. */
  setDefaults(d: ModelDefaults): void {
    this.defaults = d
  }

  /** A `provider/model`, or an alias (`paid`, `strata`, `lmstudio`) resolved to its default. */
  resolve(ref: string): string {
    return ref.includes('/') ? ref : (this.defaults.aliases[ref] ?? ref)
  }

  /**
   * Sorts a list of refs (aliases kept) by the group order (`modelOrder`): `paid` is every API model, then `strata`, `lmstudio`,
   * keeping the list's own order inside a group; a model in no group goes last. Without an order the list is returned as it is.
   */
  orderRefs(list: readonly string[]): string[] {
    const order = this.defaults.order ?? []
    if (order.length === 0) return [...list]
    const rank = (ref: string) => {
      const g = this.groupOf(ref)
      const i = g ? order.indexOf(g) : -1
      return i < 0 ? order.length : i
    }
    return list.map((ref, i) => ({ ref, i, r: rank(ref) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.ref)
  }

  /** The group of an alias or a `provider/model`: `strata`, `lmstudio`, `paid` for an API provider, undefined for another local one. */
  groupOf(ref: string): string | undefined {
    const provider = this.resolve(ref).split('/')[0]!
    if (provider === 'strata' || provider === 'lmstudio') return provider
    const p = this.providers.get(provider)
    return p && !p.local ? 'paid' : undefined
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
