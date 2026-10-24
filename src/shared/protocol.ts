import type { DocFormat } from './ir'
import type { ChunkRecord, ChunkState, Estimate, GlossaryEntry, ProjectFile, ProjectSettings, ProjectSummary } from './project'
import type { AgentName } from './agents'
import type { DefaultsConfig } from './schemas'
import type { ClientTaskSummary } from '../engine/models/client'

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
  /** Label for the UI: `name` of providers.md, else the id. */
  name: string
  /** Added in the Models dialog: editable and removable there, and its own group. */
  custom: boolean
  kind: string
  enabled: boolean
  local: boolean
  baseUrl?: string
  /** Name of the environment variable / credential-store entry that holds the key. Absent for providers without a key. */
  apiKeyEnv?: string
  /** A key was found (environment or credential store). Never the key itself. */
  hasKey: boolean
  /** Requests at once. With `concurrencyAuto` the server sets it (Strata, LM Studio), so it can't be changed here. */
  concurrency: number
  concurrencyAuto: boolean
  /** `concurrencyAuto` server that did not answer the last check: skipped while another model is left. */
  down: boolean
  /** Requests per minute and per day; missing means no limit. */
  rpm?: number
  rpd?: number
  /** Requests sent since midnight UTC (in memory: starts at 0 after a restart). */
  requestsToday: number
  /** The daily limit is used up: its work uses the next model until `dayResetsAt` (epoch ms). */
  dayFull: boolean
  dayResetsAt: number
  /** LM Studio: the engine loads a model that isn't loaded yet. */
  loadModels: boolean
  /** The JSON schema is sent as `response_format` (`json_schema` of providers.md). */
  jsonSchema: boolean
  /** `discover` of providers.md. */
  discover: boolean | 'free'
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
  /** The pickers offer it (it is not in `hidden` of config/models.md). */
  shown: boolean
  /** It came from `picked` in config/models.md (the Models dialog), not from providers.md. */
  picked: boolean
  maxOutput?: number
}

/** A model a provider lists, from `detectModels`. */
export interface CatalogModel {
  id: string
  /** `provider/model`. */
  ref: string
  context?: number
  /** USD per 1M tokens, when the provider lists prices. */
  priceIn?: number
  priceOut?: number
  /** It can be shown in the pickers: local, or with a listed price (a paid model without a price never is). */
  pickable: boolean
}

/** The answer to `detectModels`. */
export interface CatalogResult {
  provider: string
  models: CatalogModel[]
  /** ISO time of the listing. */
  at: string
}

export interface ModelsInfo {
  providers: ProviderSummary[]
  /** Every `api_key_env` of the providers (the key names the Settings screen can store a key under). */
  keyNames: string[]
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

/** The answer to `prepareChunks`: the chunks that were made (or kept) and the token budget they were planned with. */
export interface PrepareChunksResult {
  chunks: ChunkBrief[]
  budget: number
}

/** One chunk for an outside translator (an MCP client): the same messages the app's translator agent would send. */
export interface TranslationTask {
  /** Chunk index, 1-based. */
  index: number
  sectionId: string
  /** Chunks of the project that are still pending or failed (this one included). */
  remaining: number
  /** The ids the reply must contain, each exactly once. */
  segmentIds: string[]
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** What to send back with `submitTranslation`. */
  instructions: string
}

/** The answer to `submitTranslation`. `ok: false` means nothing was saved: fix `problems` and submit again. */
export interface SubmitResult {
  ok: boolean
  state: ChunkState
  problems: string[]
  remaining: number
}

/** A task of the `client` provider as an MCP client gets it (`getClientTask`), or `none` when nothing waits. */
export type ClientTaskResult =
  | { none: true; waiting: number }
  | {
      taskId: string
      meta: { job: string; call: number; role: string; task: string; project: string; unit: string; client: string }
      /** All system messages, joined. */
      system: string
      /** The user and assistant messages in order, joined. */
      user: string
      /** Only for a multi-turn request (an assistant turn, such as a JSON repair round, or more than one user message): the conversation in order; answer its last user message. */
      messages?: { role: string; content: string }[]
      schema?: Record<string, unknown>
      maxTokens?: number
      /** What the answer must look like. */
      output: string
      leaseMinutes: number
    }

/** Counts of the `client` tasks. */
export interface ClientTaskCounts {
  waiting: number
  leased: number
}

/** The MCP server (src/engine/mcp). `token` is the bearer token: the UI shows it, `serve` never prints it. */
export interface McpStatus {
  enabled: boolean
  running: boolean
  url?: string
  error?: string
  token?: string
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
  /** A number, or `auto` (local servers: the server's own slot count). */
  concurrency?: number | 'auto'
}

/** The Add provider form of the Models dialog. */
export interface CustomProviderForm {
  /** The id of the custom provider to edit. Missing: a new one (its id is the slug of `name`). */
  id?: string
  name: string
  baseUrl: string
  /** Stored in the credential store. Empty on an edit keeps the stored key. */
  apiKey?: string
  /** Free: `local: true` (no key needed, no budget). Otherwise paid: its models need prices. */
  free: boolean
  /** Send the JSON schema as `response_format` (default off for a new provider). */
  jsonSchema: boolean
  concurrency: number | 'auto'
  enabled: boolean
}

/** What `testCustomProvider` found. */
export interface CustomProviderTest {
  ok: boolean
  models?: number
  error?: string
}

export interface DefaultsPatch {
  agentModels?: Partial<Record<AgentName, string[]>>
  defaultMaxChunkTokens?: number
  /** `provider/model` behind each alias. Merged key by key. */
  groupDefaults?: Partial<Record<string, string>>
  /** The whole group order, replacing the old one. `[]`: each list keeps its own order. */
  modelOrder?: string[]
  lmstudio?: Partial<{ parallel: number; context: number; ttlMinutes: number }>
  parallel?: Partial<{ enabled: boolean; maxAtOnce: 'auto' | number; splitSections: boolean }>
  mcp?: Partial<{ enabled: boolean; port: number }>
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
  /** EPUB: `cover: 'title'` replaces the cover image by a plain title page with the translated title (default: the source cover, alt text translated). */
  | { type: 'export'; projectId: string; outPath?: string; cover?: 'source' | 'title' }
  | { type: 'deleteProject'; projectId: string }
  /** Asks a provider for every chat model it lists (`GET /models`). The list is kept for `showModels`. */
  | { type: 'detectModels'; provider: string }
  /** Shows models in the pickers (`show: true`) or hides them (config/models.md). A listed model that isn't known yet is added with its listed price. */
  | { type: 'showModels'; provider: string; refs: string[]; show: boolean }
  /** Adds a model by its id to `picked` in config/models.md. A paid provider needs both prices (USD per 1M tokens, 0 for free). */
  | { type: 'addModel'; provider: string; id: string; priceIn?: number; priceOut?: number; context?: number }
  /** Sets a provider's limits in config/models.md, over providers.md. 0 for `rpm` or `rpd` means no limit; a field left out keeps its value. */
  | { type: 'setProviderLimits'; provider: string; concurrency?: number; rpm?: number; rpd?: number }
  /** Adds a custom OpenAI-compatible provider to providers.md (comments kept), or edits the one with `id`. The key goes to the credential store. */
  | ({ type: 'saveCustomProvider' } & CustomProviderForm)
  /** Removes a custom provider, its stored key, and its refs in models.md and defaults.json. */
  | { type: 'removeCustomProvider'; id: string }
  /** Asks a server for its models (`GET /models`) before it is saved: reachable with a count, or the error. */
  | { type: 'testCustomProvider'; baseUrl: string; apiKey?: string; id?: string }
  /** Checks the `concurrency: auto` servers now (Strata was just started), instead of at the next 10-second check. */
  | { type: 'checkServers' }
  /** Changes a project's settings (models, agents on or off, parallel, chunk size ...). Refused while the project runs. */
  | { type: 'updateProjectSettings'; projectId: string; patch: Partial<ProjectSettings> }
  /** Makes the chunk files without running anything (no translator model needed), for an outside translator. Chunks are planned again only while all of them are pending. */
  | { type: 'prepareChunks'; projectId: string; maxChunkTokens?: number }
  /** The next chunk to translate (or chunk `index`) as the messages the app's translator would send. Refused while the project runs. */
  | { type: 'getTranslationTask'; projectId: string; index?: number }
  /** Saves an outside translation of a chunk: a raw `<seg id>` reply, or an id to text map. All or nothing. Refused while the project runs. */
  | { type: 'submitTranslation'; projectId: string; index: number; reply?: string; segments?: Record<string, string>; model?: string }
  /** Writes brief.md (tone, characters ...) of a project. */
  | { type: 'setBrief'; projectId: string; brief: string }
  /** The MCP server's state, and its token once enabled. */
  | { type: 'getMcpStatus' }
  /** The waiting and leased requests of the `client` provider. */
  | { type: 'listClientTasks' }
  /** Leases the oldest waiting `client` task that matches (an MCP client answers it with `submitClientTask`). */
  | { type: 'getClientTask'; client?: string; role?: string; project?: string; task?: string; leaseMinutes?: number }
  /** Answers a `client` task. A reply that fails the task's schema is not accepted and the task stays leased. */
  | { type: 'submitClientTask'; taskId: string; text: string }
  /** Gives a leased `client` task back to the queue, or (with `project` and/or `role`, no `taskId`) every leased task that matches. */
  | { type: 'releaseClientTask'; taskId?: string; client?: string; project?: string; role?: string }

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
  detectModels: CatalogResult
  showModels: ModelsInfo
  addModel: ModelsInfo
  setProviderLimits: ModelsInfo
  saveCustomProvider: ModelsInfo
  removeCustomProvider: ModelsInfo
  testCustomProvider: CustomProviderTest
  checkServers: ModelsInfo
  updateProjectSettings: ProjectDetail
  prepareChunks: PrepareChunksResult
  getTranslationTask: TranslationTask
  submitTranslation: SubmitResult
  setBrief: undefined
  getMcpStatus: McpStatus
  listClientTasks: ClientTaskCounts & { tasks: ClientTaskSummary[] }
  getClientTask: ClientTaskResult
  submitClientTask: { accepted: true } | { accepted: false; problems: string[] }
  releaseClientTask: { released: boolean | number }
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

/** A book the reader opens: a local file, or the original file of a project. */
export type BookTarget = { path: string } | { projectId: string }

/** A book file read by the main process. `ext` is lower case with the dot. */
export interface BookFile {
  name: string
  ext: string
  bytes: Uint8Array
}

/** The documents of a folder that the app can translate (top level only, natural name order, absolute paths). A visual-novel book folder is one document. */
export interface FolderListing {
  folder: string
  files: string[]
  /** The folder is itself a visual-novel book folder (book.md and chapters/): `files` is the folder. */
  book?: boolean
}

/** What the preload script exposes to the renderer as `window.bt`. */
export interface BookTranslatorApi {
  /** Subscribes to engine events. Returns the unsubscribe function. */
  on(handler: (event: EngineEvent) => void): () => void
  /** Sends a command and waits for its reply. Rejects with the engine's error message. */
  request<K extends CommandType>(command: CommandOf<K>): Promise<CommandResults[K]>
  /** The file dialog (filters from the supported extensions). Null when cancelled. */
  pickFile(): Promise<string | null>
  /** The folder dialog: the documents in the chosen folder. Null when cancelled. */
  pickFolder(): Promise<FolderListing | null>
  /** The documents in a folder (for a dropped folder). Rejects when it is not a folder. */
  listFolder(dir: string): Promise<FolderListing>
  /** The folder dialog for a visual-novel book folder (book.md and chapters/): its path. Null when cancelled. Rejects when the folder is not a book folder. */
  pickBookFolder(): Promise<string | null>
  /** The path of a dropped file or folder, '' when it has none. */
  pathForFile(file: File): string
  /** The file dialog for the reader (epub, pdf, txt, md). Null when cancelled. The chosen path may then be read with `readBook`. */
  pickBook(): Promise<string | null>
  /** Reads a book for the reader. Only a picked file, a file in the data folder, or a project's original is allowed. Rejects otherwise. */
  readBook(target: BookTarget): Promise<BookFile>
  /** Opens a folder or file inside the data folder with the system shell. `rel` is relative to the data folder. */
  openPath(rel: string): Promise<boolean>
  /** Shows an exported file in the file manager. */
  showInFolder(file: string): Promise<boolean>
}

export type { Estimate }
