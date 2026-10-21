import type { DocFormat } from './ir'
import type { AgentName } from './schemas'

/** Types of the project files (project.json, chunks/NNNN.json) shared by the engine and the UI. */

export const CHUNK_STATES = ['pending', 'translating', 'proofreading', 'reviewing', 'fixing', 'done', 'flagged', 'failed'] as const
export type ChunkState = (typeof CHUNK_STATES)[number]

/** States of a chunk that is being worked on. After a crash or abort they go back to `pending`. */
export const IN_PROGRESS_STATES: readonly ChunkState[] = ['translating', 'proofreading', 'reviewing', 'fixing']

export type IssueType = 'omission' | 'addition' | 'mistranslation' | 'glossary' | 'tags' | 'untranslated'
export type IssueSeverity = 'minor' | 'major'

export interface QaIssue {
  segId: string
  type: IssueType
  severity: IssueSeverity
  comment: string
  suggestion?: string
}

export interface GlossaryEntry {
  source: string
  target: string
  /** person, place, org, term or phrase. */
  type: string
  /** m, f, n (of the person or the target noun), when it matters. */
  gender?: string
  note?: string
}

export interface ProjectSettings {
  sourceLanguage?: string
  /** Name used in prompts, for example "Croatian". */
  targetLanguage: string
  /** Code used for the output file name and the document language tag, for example "hr". */
  targetLanguageCode?: string
  /** Per agent: ordered `provider/model` list (the first is the default, the rest are fallbacks). */
  agentModels: Record<AgentName, string[]>
  enabled: { glossary: boolean; proofreader: boolean; qa: boolean }
  /** Upper limit of a chunk, in source tokens. */
  maxChunkTokens: number
  /** Stop after the glossary is built, so it can be reviewed. */
  pauseAfterGlossary: boolean
  /** Only the `client` provider (an MCP client such as Claude Code) answers model calls: all four agents sit on `client/claude-code` and any other model ref is refused. Nothing is spent. */
  clientOnly?: boolean
  /** Visual-novel book folders only (default off): the character names are localized with the glossary's `person` entries, in speaker tags, `ON SCREEN:` lines and the bible. */
  localizeNames?: boolean
  /** Parallel translation. `maxAtOnce: auto` follows the translator provider's concurrency; `splitSections` also runs the chunks of one section at the same time. */
  parallel: ParallelSettings
}

/** The one model a client-only project uses for every agent. */
export const CLIENT_ONLY_MODEL = 'client/claude-code'

export const isClientRef = (ref: string): boolean => ref.startsWith('client/')

export interface ParallelSettings {
  enabled: boolean
  maxAtOnce: 'auto' | number
  splitSections: boolean
}

/** What a project without `parallel` in project.json gets: the behavior before the setting existed. */
export const DEFAULT_PARALLEL: ParallelSettings = { enabled: true, maxAtOnce: 'auto', splitSections: false }

export interface Spend {
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** Time spent in model calls, ms. */
  ms: number
}

export type ProjectStatus = 'created' | 'glossary' | 'translating' | 'paused' | 'glossary-review' | 'cancelled' | 'incomplete' | 'done'

export interface ProjectFile {
  id: string
  name: string
  sourcePath: string
  sourceHash: string
  format: DocFormat
  createdAt: string
  updatedAt: string
  settings: ProjectSettings
  status: ProjectStatus
  /** The glossary builder has run (glossary.md and brief.md were written). */
  glossaryDone: boolean
  /** How the chunks were made; chunks are made again only while all of them are pending and this differs. */
  chunking: { budget: number; chunks: number } | null
  spend: Spend
}

export interface SegmentRec {
  /** The block id, or `<blockId>#<n>` for a piece of a block that was too big for one chunk. */
  id: string
  blockId: string
  part?: number
  parts?: number
  text: string
}

export interface ChunkRecord {
  /** 1-based, also the file name (chunks/0001.json). */
  index: number
  sectionId: string
  blockIds: string[]
  segments: SegmentRec[]
  translation: Record<string, string>
  proofread: Record<string, string>
  /** What is exported: the latest accepted text per segment. */
  final: Record<string, string>
  qa: { issues: QaIssue[] }
  state: ChunkState
  model?: string
  tokens: { in: number; out: number }
  costUsd: number
  ms: number
  error?: string
  /** The user edited the text. */
  edited?: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  sourcePath: string
  format: DocFormat
  sourceLanguage?: string
  targetLanguage: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
  chunks: number
  done: number
  flagged: number
  failed: number
  spend: Spend
}

export interface Estimate {
  chunks: number
  sourceTokens: number
  budget: number
  estTokensIn: number
  estTokensOut: number
  estCostUsd: number
  estSeconds: number
  perAgent: Partial<Record<AgentName, { tokensIn: number; tokensOut: number; costUsd: number; seconds: number }>>
}
