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
  extra_body: z.record(z.string(), z.unknown()).nullable().optional()
})

export const providerEntrySchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['openai-compat', 'anthropic', 'gemini', 'mock']),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  /** How many requests may run at once. */
  concurrency: z.number().int().positive().default(4),
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  /** Ask the provider which models it has (GET /v1/models) and add the unknown ones. */
  discover: z.boolean().default(false),
  models: z.array(providerModelSchema).default([])
})

export const providersSchema = configBase('providers').extend({
  providers: z.array(providerEntrySchema).default([])
})

// ---- defaults ----

export { AGENTS } from './agents'
export type { AgentName } from './agents'

/** config/defaults.json: default model per agent, default chunk size, languages for the pickers. */
export const defaultsSchema = z.looseObject({
  /** Per agent: ordered `provider/model` list. The first is the default, the rest are fallbacks. */
  agentModels: z.record(z.string(), z.array(z.string())).default({}),
  defaultMaxChunkTokens: z.number().int().positive().default(1500),
  languages: z.array(z.object({ code: z.string().min(1), name: z.string().min(1), rtl: z.boolean().optional() })).default([])
})

export type ProvidersConfig = z.output<typeof providersSchema>
export type ProviderEntry = z.output<typeof providerEntrySchema>
export type ProviderModelEntry = z.output<typeof providerModelSchema>
export type DefaultsConfig = z.output<typeof defaultsSchema>
