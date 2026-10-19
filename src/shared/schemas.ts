import { z } from 'zod'

/**
 * Frontmatter schemas, one per file kind. Config files carry a `kind` field, so a file says what it is.
 * Unknown fields are kept (loose), so you can add your own notes to a file.
 */

/** Any markdown file with a frontmatter mapping. */
export const genericSchema = z.looseObject({})

const configBase = <K extends string>(kind: K) => z.looseObject({ kind: z.literal(kind) })

// ---- providers ----

export const providerModelSchema = z.looseObject({
  id: z.string().min(1),
  family: z.string().default('unknown'),
  context: z.number().int().positive().optional(),
  max_output: z.number().int().positive().optional(),
  /** USD per 1M tokens. */
  price_in: z.number().nonnegative().default(0),
  price_out: z.number().nonnegative().default(0),
  /** USD per 1M cached input tokens. Falls back to price_in when missing. */
  price_cached_in: z.number().nonnegative().optional(),
  embedding: z.boolean().default(false),
  /** Extra JSON fields merged into the request body for this model (for example to switch thinking off). */
  extra_body: z.record(z.string(), z.unknown()).nullable().optional(),
  /** `load_models` providers (LM Studio): load this model with this context window and parallel count instead of the defaults' ones. */
  load_context: z.number().int().min(2048).optional(),
  load_parallel: z.number().int().min(1).max(16).optional()
})

export const providerEntrySchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['openai-compat', 'anthropic', 'gemini', 'mock']),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  /**
   * How many requests may run at once. `auto`: as many as the server says it serves (`concurrency.serving` of
   * `GET <base_url>/status`, the Strata status), checked every few seconds; 1 while the server can't be asked.
   */
  concurrency: z.union([z.number().int().positive(), z.literal('auto')]).default(4),
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  /**
   * Requests per day, counted from midnight UTC (OpenRouter's free models: 50, or 1000 after buying 10 credits). A provider that
   * reached it is skipped until the next midnight UTC: its work goes to the next model in the list.
   */
  rpd: z.number().int().positive().optional(),
  /**
   * Ask the provider which models it has (GET /v1/models) and add the unknown ones. `free`: only the ones it lists at price 0
   * (OpenRouter's `:free` models). A paid provider's model that comes without a price is never added, so the cost is always known.
   */
  discover: z.union([z.boolean(), z.literal('free')]).default(false),
  /** Discovery leaves out models whose id contains one of these words (any case), for example `dflash`. */
  discover_skip: z.array(z.string()).default([]),
  /** Send the JSON schema as `response_format`. Set false for servers that reject a bad JSON answer (502) instead of constraining it: the prompt and the repair step handle the JSON then. */
  json_schema: z.boolean().default(true),
  /** LM Studio: the engine loads a model that isn't loaded yet itself, with the parallel, context and idle time from `lmstudio` in config/defaults.json. */
  load_models: z.boolean().default(false),
  models: z.array(providerModelSchema).default([])
})

export const providersSchema = configBase('providers').extend({
  providers: z.array(providerEntrySchema).default([])
})

/**
 * config/models.md: which models the pickers offer, set in the app's Models dialog. `picked`: models a provider lists that are
 * not in providers.md, with the price it listed when you picked them. `hidden`: `provider/model` refs the pickers leave out.
 */
export const modelsConfigSchema = configBase('models').extend({
  picked: z.array(providerModelSchema.extend({ provider: z.string().min(1) })).default([]),
  hidden: z.array(z.string()).default([]),
  /**
   * Per provider id: limits set in the Models dialog, over the ones in providers.md. `concurrency`: requests at once (not for a
   * `concurrency: auto` server). `rpm`, `rpd`: requests per minute and per day; 0 means no limit.
   */
  limits: z
    .record(
      z.string(),
      z.object({
        concurrency: z.number().int().positive().optional(),
        rpm: z.number().int().nonnegative().optional(),
        rpd: z.number().int().nonnegative().optional()
      })
    )
    .default({})
})

// ---- defaults ----

export { AGENTS } from './agents'
export type { AgentName } from './agents'

/** config/defaults.json: default model per agent, default chunk size, languages for the pickers. */
export const defaultsSchema = z.looseObject({
  /** Per agent: ordered `provider/model` list. The first is the default, the rest are fallbacks. */
  agentModels: z.record(z.string(), z.array(z.string())).default({}),
  defaultMaxChunkTokens: z.number().int().positive().default(1500),
  languages: z.array(z.object({ code: z.string().min(1), name: z.string().min(1), rtl: z.boolean().optional() })).default([]),
  /** The aliases `paid`, `strata`, `lmstudio` in an `agentModels` list mean one `provider/model` each, set here. */
  groupDefaults: z.object({ paid: z.string().optional(), strata: z.string().optional(), lmstudio: z.string().optional() }).default({}),
  /** The groups in the order every agent tries them. Empty: each agent's list keeps its own order. */
  modelOrder: z.array(z.enum(['paid', 'strata', 'lmstudio'])).default([]),
  /** LM Studio models the engine loads itself (`load_models`): parallel requests, context window, idle minutes before unloading. */
  lmstudio: z
    .object({
      parallel: z.number().int().min(1).max(16).default(4),
      context: z.number().int().min(2048).default(131072),
      ttlMinutes: z.number().int().min(1).default(60)
    })
    .default({ parallel: 4, context: 131072, ttlMinutes: 60 }),
  /** Defaults for a new project's parallel translation. `maxAtOnce: auto` follows the provider's concurrency. */
  parallel: z
    .object({
      enabled: z.boolean().default(true),
      maxAtOnce: z.union([z.literal('auto'), z.number().int().min(1).max(16)]).default('auto'),
      splitSections: z.boolean().default(false)
    })
    .default({ enabled: true, maxAtOnce: 'auto', splitSections: false }),
  /** The MCP server (lets another LLM client drive the app): off by default, on 127.0.0.1 at `port`. */
  mcp: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1024).max(65535).default(47811)
    })
    .default({ enabled: false, port: 47811 })
})

export type ProvidersConfig = z.output<typeof providersSchema>
export type ModelsConfig = z.output<typeof modelsConfigSchema>
export type ProviderEntry = z.output<typeof providerEntrySchema>
export type ProviderModelEntry = z.output<typeof providerModelSchema>
export type DefaultsConfig = z.output<typeof defaultsSchema>
