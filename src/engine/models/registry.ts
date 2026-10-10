import path from 'node:path'
import { parseMdWith } from '../../shared/md'
import { providersSchema } from '../../shared/schemas'
import type { ProviderEntry } from '../../shared/schemas'
import { promises as fs } from 'node:fs'
import { AnthropicClient } from './anthropic'
import { GeminiClient } from './gemini'
import { resolveKey } from './keys'
import type { KeyResolver } from './keys'
import { MockProvider } from './mock'
import { OpenAiCompatClient } from './openaiCompat'
import type { ProviderClient } from './types'

export interface ProviderInfo {
  id: string
  kind: ProviderEntry['kind']
  enabled: boolean
  local: boolean
  baseUrl?: string
  apiKeyEnv?: string
  concurrency: number
  rpm?: number
  discover: boolean
  /** Send the JSON schema as `response_format` (`openai-compat`). */
  jsonSchema: boolean
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
}

export interface RegistryOptions {
  keys?: KeyResolver
  fetchImpl?: typeof fetch
  /** Reuse a mock provider so tests can script it. */
  mock?: MockProvider
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

export class ModelRegistry {
  providers = new Map<string, ProviderInfo>()
  models = new Map<string, ModelInfo>()
  readonly mock: MockProvider

  constructor(
    private readonly dataDir: string,
    private readonly opts: RegistryOptions = {}
  ) {
    this.mock = opts.mock ?? new MockProvider('mock')
  }

  /** (Re)reads config/providers.md. Keeps the previous state if the file is invalid. */
  async load(): Promise<void> {
    const provFile = path.join(this.dataDir, 'config', 'providers.md')
    const prov = parseMdWith(await fs.readFile(provFile, 'utf8'), providersSchema, provFile)
    const keys = this.opts.keys ?? resolveKey
    const discoveredBefore = [...this.models.values()].filter((m) => m.discovered)

    const providers = new Map<string, ProviderInfo>()
    const models = new Map<string, ModelInfo>()
    for (const p of prov.data.providers) {
      const info: ProviderInfo = {
        id: p.id,
        kind: p.kind,
        enabled: p.enabled,
        local: p.local,
        baseUrl: p.base_url,
        apiKeyEnv: p.api_key_env,
        concurrency: p.concurrency,
        rpm: p.rpm,
        discover: p.discover,
        jsonSchema: p.json_schema,
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
          context: m.context,
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
    // Keep what discovery found earlier, so a config reload does not forget it.
    for (const d of discoveredBefore) {
      const prov = this.providers.get(d.provider.id)
      if (prov && !this.models.has(d.ref)) this.models.set(d.ref, { ...d, provider: prov })
    }
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
        jsonSchema: info.jsonSchema
      })
    } else if (info.kind === 'anthropic') {
      info.client = new AnthropicClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    } else if (info.kind === 'gemini') {
      info.client = new GeminiClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    }
    info.available = true
  }

  /** `GET /models` on every provider with `discover: true`. Adds unknown models, family guessed from the id. */
  async discover(signal?: AbortSignal): Promise<{ provider: string; found: number; error?: string }[]> {
    const out: { provider: string; found: number; error?: string }[] = []
    for (const p of this.providers.values()) {
      if (!p.discover || !p.available || !(p.client instanceof OpenAiCompatClient)) continue
      try {
        const ids = await p.client.listModels(signal)
        const ctxLen = await p.client.contextLengths(signal)
        for (const id of ids) {
          const ref = `${p.id}/${id}`
          if (this.models.has(ref)) continue
          this.models.set(ref, {
            ref,
            provider: p,
            id,
            family: guessFamily(id),
            priceIn: 0,
            priceOut: 0,
            priceCachedIn: 0,
            embedding: /embed/i.test(id),
            extraBody: null,
            discovered: true
          })
        }
        // the context the model is loaded with (LM Studio)
        for (const [id, len] of ctxLen) {
          const m = this.models.get(`${p.id}/${id}`)
          if (m) m.loadedContext = len
        }
        out.push({ provider: p.id, found: ids.length })
      } catch (err) {
        out.push({ provider: p.id, found: 0, error: (err as Error).message })
      }
    }
    return out
  }

  getModel(ref: string): ModelInfo | undefined {
    return this.models.get(ref)
  }

  /** The context window to plan with: LM Studio's loaded context, else `context` in providers.md, else 8192. */
  contextLength(ref: string): number {
    const m = this.models.get(ref)
    return m?.loadedContext ?? m?.context ?? DEFAULT_CONTEXT
  }

  /** Chat models that can be used right now (provider available, not an embedding model), in registry order. */
  usableModels(): ModelInfo[] {
    return [...this.models.values()].filter((m) => m.provider.available && m.provider.client && !m.embedding)
  }
}

export function guessFamily(id: string): string {
  const s = id.toLowerCase()
  for (const f of ['qwen', 'nemotron', 'poolside', 'laguna', 'deepseek', 'llama', 'mistral', 'gemma', 'nomic', 'glm', 'kimi']) {
    if (s.includes(f)) return f === 'laguna' ? 'poolside' : f
  }
  return 'unknown'
}
