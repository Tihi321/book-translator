import type { DocFormat } from './ir'
import type { ChunkRecord, ChunkState, Estimate, GlossaryEntry, ProjectFile, ProjectSettings, ProjectSummary } from './project'
import type { AgentName } from './agents'
import type { DefaultsConfig } from './schemas'

/**
 * Engine <-> UI protocol. The engine service (src/engine/service.ts) has one method per command; events flow the other way.
 * A command travels in a `Request` with an id, and the engine answers with a `reply` event carrying the same id.
 */

export interface ProgressInfo {
  done: number
  total: number
  perStage: Record<ChunkState, number>
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** Seconds left, estimated from this run's speed. Null until a chunk has finished. */
  etaSec: number | null
}

// ---- data returned by commands ----

export interface ProviderSummary {
  id: string
  kind: string
  enabled: boolean
  local: boolean
  baseUrl?: string
  /** Name of the environment variable / credential-store entry that holds the key. Absent for providers without a key. */
  apiKeyEnv?: string
  /** A key was found (environment or credential store). Never the key itself. */
  hasKey: boolean
  concurrency: number
  /** Enabled and usable now (local, or has a key). */
  available: boolean
  unavailableReason?: string
}

export interface ModelSummary {
  /** `provider/model`. */
  ref: string
  provider: string
  model: string
  family: string
  local: boolean
  /** The provider is usable now. */
  available: boolean
  /** Context window planned with (LM Studio's loaded context, else providers.md, else 8192). */
  context: number
  /** The context is the one the model is loaded with. */
  loaded: boolean
  /** USD per 1M tokens. */
  priceIn: number
  priceOut: number
  discovered: boolean
}

export interface ModelsInfo {
  providers: ProviderSummary[]
  models: ModelSummary[]
  /** Result of the last discovery of local servers. */
  discovery: { provider: string; found: number; error?: string }[]
}

export interface FileInfo {
  path: string
  format: DocFormat
  title?: string
  language?: string
  sections: number
  blocks: number
  words: number
  tokens: number
  /** Extension of the exported file (`.epub` for a PDF source). */
  outputExt: string
}

export interface AnalyzeResult {
  file: FileInfo
  estimate: Estimate
}

/** A chunk without its text, for the tiles. */
export interface ChunkBrief {
  index: number
  sectionId: string
  state: ChunkState
  issues: number
  majorIssues: number
  model?: string
  tokensIn: number
  tokensOut: number
  edited?: boolean
  error?: string
}

export interface ProjectDetail {
  project: ProjectFile
  chunks: ChunkBrief[]
  sections: { id: string; title?: string }[]
  glossary: GlossaryEntry[]
  brief: string
  /** The last lines of log.md. */
  log: string
  running: boolean
  /** Folder of the exported files, relative to the data folder (forward slashes). */
  outputRel: string
}

export interface EngineInfo {
  dataDir: string
  extensions: string[]
  mock: boolean
}

export interface ProviderPatch {
  id: string
  enabled?: boolean
  baseUrl?: string
  concurrency?: number
}

export interface DefaultsPatch {
  agentModels?: Partial<Record<AgentName, string[]>>
  defaultMaxChunkTokens?: number
}

// ---- events ----

export type EngineEvent =
  | { type: 'engine.ready'; info: EngineInfo }
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'snapshot'; projects: ProjectSummary[] }
  | { type: 'models'; models: ModelsInfo }
  | { type: 'project.updated'; project: ProjectSummary }
  | { type: 'project.deleted'; projectId: string }
  | { type: 'chunk.state'; projectId: string; index: number; state: ChunkState; model?: string; tokens?: { in: number; out: number }; issues?: number }
  /** Live text of the model reply. `text` is the new piece since the last event (throttled to about 100 ms). */
  | { type: 'chunk.token'; projectId: string; index: number; stage: ChunkState; text: string }
  | ({ type: 'progress'; projectId: string } & ProgressInfo)
  | { type: 'log'; projectId?: string; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; projectId?: string; message: string }

// ---- commands ----

export type Command =
  | { type: 'getInfo' }
  | { type: 'snapshot' }
  | { type: 'listModels' }
  | { type: 'refreshModels' }
  | { type: 'setSecret'; name: string; value: string }
  | { type: 'saveProviders'; providers: ProviderPatch[] }
  | { type: 'getDefaults' }
  | { type: 'setDefaults'; patch: DefaultsPatch }
  | { type: 'createProject'; sourcePath: string; targetLanguage: string; sourceLanguage?: string; settings?: Partial<ProjectSettings>; id?: string }
  /** Parses and estimates. Either an existing project, or a file that is not a project yet (nothing is created). */
  | { type: 'analyze'; projectId?: string; sourcePath?: string; targetLanguage?: string; sourceLanguage?: string; settings?: Partial<ProjectSettings> }
  | { type: 'getProject'; projectId: string }
  | { type: 'getChunk'; projectId: string; index: number }
  | { type: 'start'; projectId: string }
  | { type: 'pause'; projectId: string }
  | { type: 'resume'; projectId: string }
  | { type: 'cancel'; projectId: string }
  | { type: 'retryChunk'; projectId: string; index: number; model?: string }
  | { type: 'editChunk'; projectId: string; index: number; final: Record<string, string> }
  | { type: 'updateGlossary'; projectId: string; entries: GlossaryEntry[] }
  | { type: 'export'; projectId: string; outPath?: string }
  | { type: 'deleteProject'; projectId: string }

export type CommandType = Command['type']

/** The result of each command (what the `reply` carries). */
export interface CommandResults {
  getInfo: EngineInfo
  snapshot: undefined
  listModels: ModelsInfo
  refreshModels: ModelsInfo
  setSecret: ModelsInfo
  saveProviders: ModelsInfo
  getDefaults: DefaultsConfig
  setDefaults: DefaultsConfig
  createProject: ProjectSummary
  analyze: AnalyzeResult
  getProject: ProjectDetail
  getChunk: ChunkRecord
  start: undefined
  pause: undefined
  resume: undefined
  cancel: undefined
  retryChunk: undefined
  editChunk: ChunkRecord
  updateGlossary: undefined
  export: { path: string; rel: string | null }
  deleteProject: undefined
}

export type CommandOf<K extends CommandType> = Extract<Command, { type: K }>

/** A command on the wire. */
export interface Request {
  id: number
  command: Command
}

export function isRequest(v: unknown): v is Request {
  if (typeof v !== 'object' || v === null) return false
  const r = v as { id?: unknown; command?: unknown }
  return typeof r.id === 'number' && typeof r.command === 'object' && r.command !== null && typeof (r.command as { type?: unknown }).type === 'string'
}

/** A message channel. Engine side: `Transport<Request, EngineEvent>`. Main-process side: the reverse. */
export interface Transport<In, Out> {
  send(message: Out): void
  onMessage(handler: (message: In) => void): () => void
  close(): void
}

export type EngineTransport = Transport<Request, EngineEvent>

/** What the preload script exposes to the renderer as `window.bt`. */
export interface BookTranslatorApi {
  /** Subscribes to engine events. Returns the unsubscribe function. */
  on(handler: (event: EngineEvent) => void): () => void
  /** Sends a command and waits for its reply. Rejects with the engine's error message. */
  request<K extends CommandType>(command: CommandOf<K>): Promise<CommandResults[K]>
  /** The file dialog (filters from the supported extensions). Null when cancelled. */
  pickFile(): Promise<string | null>
  /** Opens a folder or file inside the data folder with the system shell. `rel` is relative to the data folder. */
  openPath(rel: string): Promise<boolean>
  /** Shows an exported file in the file manager. */
  showInFolder(file: string): Promise<boolean>
}

export type { Estimate }
