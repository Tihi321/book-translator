import path from 'node:path'
import { promises as fs } from 'node:fs'
import { chunkBudget, planChunks } from './chunker'
import { loadDefaults, resolveLanguage } from './config'
import { adapterFor } from './formats'
import { ModelRouter } from './models/router'
import type { RouterOptions } from './models/router'
import { computeCost, isPaidModel } from './models/registry'
import type { ModelRegistry } from './models/registry'
import { budgetFor, ProjectRunner } from './pipeline/runner'
import type { RunResult } from './pipeline/runner'
import { hashFile, mergeSettings, ProjectStore, projectIdFor } from './project/store'
import { summarize } from './project/summary'
import type { DocumentIR } from '../shared/ir'
import type { ChunkRecord, Estimate, GlossaryEntry, ProjectFile, ProjectSettings, ProjectSummary } from '../shared/project'
import type { EngineEvent, ProjectDetail } from '../shared/protocol'
import { AGENTS } from '../shared/schemas'
import type { AgentName } from '../shared/schemas'

export interface ServiceOptions {
  dataDir: string
  registry: ModelRegistry
  emit?: (ev: EngineEvent) => void
  router?: ModelRouter
  routerOptions?: RouterOptions
}

export interface CreateProjectRequest {
  sourcePath: string
  targetLanguage: string
  sourceLanguage?: string
  settings?: Partial<ProjectSettings>
  id?: string
}

/** Output speed assumed for the time estimate, tokens per second. */
const LOCAL_TPS = 30
const API_TPS = 80
/** Typical overhead per chunk request (rules, prompt, brief, glossary slice, previous tail) and expansion of the target text. */
const PROMPT_TOKENS = 1000
const EXPANSION = 1.2

/** The ways an adapter may differ from the minimal FormatAdapter: an output extension and a target language hint for `write`. */
interface AdapterExtras {
  outputExt?: string
  write(ir: DocumentIR, translations: Map<string, string>, srcPath: string, outPath: string, opts?: { targetLanguage?: string }): Promise<void>
}

/**
 * The engine's API: one method per protocol command (the transport in Phase 5 maps `Command`s to these). Progress comes back
 * through `emit` as `EngineEvent`s. `start` and `resume` return a promise that settles when the run ends: the caller need not await it.
 */
export class EngineService {
  readonly store: ProjectStore
  readonly router: ModelRouter
  private readonly emit: (ev: EngineEvent) => void
  private runs = new Map<string, { controller: AbortController; promise: Promise<RunResult> }>()

  constructor(private readonly opts: ServiceOptions) {
    this.store = new ProjectStore(opts.dataDir)
    this.router = opts.router ?? new ModelRouter(opts.registry, opts.routerOptions)
    this.emit = opts.emit ?? (() => undefined)
  }

  get registry(): ModelRegistry {
    return this.opts.registry
  }

  // ---- projects ----

  async listProjects(): Promise<ProjectSummary[]> {
    const out: ProjectSummary[] = []
    for (const p of await this.store.list()) out.push(summarize(p, await this.store.listChunks(p.id)))
    return out
  }

  async snapshot(): Promise<void> {
    this.emit({ type: 'snapshot', projects: await this.listProjects() })
  }

  async getProject(id: string): Promise<ProjectFile> {
    return this.store.load(id)
  }

  /** Default settings: models and chunk size from config/defaults.json, all agents on. */
  async defaultSettings(targetLanguage: string, sourceLanguage?: string): Promise<ProjectSettings> {
    const defaults = await loadDefaults(this.opts.dataDir)
    const lang = resolveLanguage(defaults, targetLanguage)
    const agentModels = Object.fromEntries(AGENTS.map((a) => [a, defaults.agentModels[a] ?? []])) as Record<AgentName, string[]>
    return {
      sourceLanguage: sourceLanguage ? resolveLanguage(defaults, sourceLanguage).name : undefined,
      targetLanguage: lang.name,
      targetLanguageCode: lang.code,
      agentModels,
      enabled: { glossary: true, proofreader: true, qa: true },
      maxChunkTokens: defaults.defaultMaxChunkTokens,
      pauseAfterGlossary: false
    }
  }

  /** Creates the project (project.json, source.json ...). The same file and language give the same project: its settings are updated. */
  async createProject(req: CreateProjectRequest): Promise<ProjectSummary> {
    const sourcePath = path.resolve(req.sourcePath)
    const hash = await hashFile(sourcePath)
    const base = await this.defaultSettings(req.targetLanguage, req.sourceLanguage)
    const settings = mergeSettings(base, req.settings)
    const id = req.id ?? projectIdFor(sourcePath, settings.targetLanguageCode ?? settings.targetLanguage, hash)
    if (await this.store.exists(id)) {
      const existing = await this.store.load(id)
      existing.settings = mergeSettings(existing.settings, req.settings)
      await this.store.save(existing)
      return summarize(existing, await this.store.listChunks(id))
    }
    const ir = await adapterFor(sourcePath).read(sourcePath)
    if (!settings.sourceLanguage && ir.meta.language) settings.sourceLanguage = ir.meta.language
    const now = new Date().toISOString()
    const project: ProjectFile = {
      id,
      name: ir.meta.title?.trim() || path.basename(sourcePath, path.extname(sourcePath)),
      sourcePath,
      sourceHash: hash,
      format: ir.format,
      createdAt: now,
      updatedAt: now,
      settings,
      status: 'created',
      glossaryDone: false,
      chunking: null,
      spend: { tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0 }
    }
    await this.store.create(project, ir)
    const summary = summarize(project, [])
    this.emit({ type: 'project.updated', project: summary })
    return summary
  }

  async deleteProject(id: string): Promise<void> {
    await this.cancel(id)
    await this.store.remove(id)
    this.emit({ type: 'project.deleted', projectId: id })
  }

  /** Parses (from source.json), chunks and estimates tokens, cost and time for the agents that are on. `settings` overrides the saved ones for the estimate. */
  async analyze(id: string, override?: Partial<ProjectSettings>): Promise<Estimate> {
    const project = await this.store.load(id)
    return this.estimate(await this.store.readIr(id), mergeSettings(project.settings, override))
  }

  /** The estimate for a document and settings (no project needed). */
  estimate(ir: DocumentIR, settings: ProjectSettings): Estimate {
    const budget = budgetFor(this.registry, this.router, settings)
    const chunks = planChunks(ir, budget)
    const sourceTokens = chunks.reduce((n, c) => n + c.tokens, 0)
    const perAgent: Estimate['perAgent'] = {}
    const add = (agent: AgentName, tokensIn: number, tokensOut: number) => {
      const m = this.router.resolve(settings.agentModels[agent] ?? [])[0]
      const costUsd = m && isPaidModel(m) ? computeCost(m, { inputTokens: tokensIn, cachedInputTokens: 0, outputTokens: tokensOut }) : 0
      const tps = !m || m.provider.local ? LOCAL_TPS : API_TPS
      const seconds = tokensOut / tps / Math.max(1, m?.provider.concurrency ?? 1)
      perAgent[agent] = { tokensIn, tokensOut, costUsd, seconds }
    }
    const n = chunks.length
    const out = Math.round(sourceTokens * EXPANSION)
    add('translator', sourceTokens + n * PROMPT_TOKENS, out)
    if (settings.enabled.proofreader) add('proofreader', sourceTokens + out + n * PROMPT_TOKENS, out)
    if (settings.enabled.qa) add('qa', sourceTokens + out + n * PROMPT_TOKENS, n * 200)
    if (settings.enabled.glossary) {
      const gm = this.router.resolve(settings.agentModels.glossary ?? [])[0]
      const gBudget = chunkBudget({ contexts: gm ? [this.registry.contextLength(gm.ref)] : [], userMax: 6000, promptOverhead: 900, glossarySlice: 1500, prevContext: 0, expansion: 0.4 })
      const passes = Math.max(1, Math.ceil(sourceTokens / gBudget))
      add('glossary', sourceTokens + passes * 2400, passes * 500)
    }
    const all = Object.values(perAgent)
    return {
      chunks: n,
      sourceTokens,
      budget,
      estTokensIn: all.reduce((s, a) => s + a.tokensIn, 0),
      estTokensOut: all.reduce((s, a) => s + a.tokensOut, 0),
      estCostUsd: all.reduce((s, a) => s + a.costUsd, 0),
      estSeconds: Math.round(all.reduce((s, a) => s + a.seconds, 0)),
      perAgent
    }
  }

  /** Everything the project screen needs except chunk texts (those are fetched one at a time with `store.readChunk`). */
  async detail(id: string): Promise<ProjectDetail> {
    const [project, chunks, ir, glossary, brief] = await Promise.all([this.store.load(id), this.store.listChunks(id), this.store.readIr(id), this.store.readGlossary(id), this.store.readBrief(id)])
    let log = ''
    try {
      log = (await fs.readFile(this.store.file(id, 'log.md'), 'utf8')).split('\n').slice(-300).join('\n')
    } catch {
      // no log yet
    }
    return {
      project,
      chunks: chunks.map((c) => ({
        index: c.index,
        sectionId: c.sectionId,
        state: c.state,
        issues: c.qa.issues.length,
        majorIssues: c.qa.issues.filter((i) => i.severity === 'major').length,
        model: c.model,
        tokensIn: c.tokens.in,
        tokensOut: c.tokens.out,
        edited: c.edited,
        error: c.error
      })),
      sections: ir.sections.map((s) => ({ id: s.id, title: s.title })),
      glossary,
      brief,
      log,
      running: this.runs.has(id),
      outputRel: `projects/${id}/output`
    }
  }

  // ---- running ----

  /** Starts (or resumes) the pipeline. Already running: returns that run. */
  start(id: string, opts: { only?: number[]; translatorModel?: string } = {}): Promise<RunResult> {
    const running = this.runs.get(id)
    if (running) return running.promise
    const controller = new AbortController()
    const runner = new ProjectRunner({ dataDir: this.opts.dataDir, registry: this.registry, router: this.router, store: this.store, emit: this.emit }, id)
    const promise = runner
      .run({ signal: controller.signal, ...opts })
      .catch((err: unknown) => {
        this.emit({ type: 'error', projectId: id, message: (err as Error).message })
        throw err
      })
      .finally(() => {
        this.runs.delete(id)
      })
    this.runs.set(id, { controller, promise })
    // callers that do not await still must not trigger an unhandled rejection
    promise.catch(() => undefined)
    return promise
  }

  resume(id: string): Promise<RunResult> {
    return this.start(id)
  }

  isRunning(id: string): boolean {
    return this.runs.has(id)
  }

  /** Stops after the requests in flight are cancelled; chunks that were in progress go back to pending. Resume with `start`. */
  async pause(id: string): Promise<void> {
    await this.stop(id, 'pause')
  }

  async cancel(id: string): Promise<void> {
    await this.stop(id, 'cancel')
  }

  private async stop(id: string, reason: 'pause' | 'cancel'): Promise<void> {
    const run = this.runs.get(id)
    if (!run) return
    run.controller.abort(reason)
    await run.promise.catch(() => undefined)
  }

  /** Resets one chunk and runs it again, optionally trying another translator model first. */
  retryChunk(id: string, index: number, model?: string): Promise<RunResult> {
    return this.start(id, { only: [index], translatorModel: model })
  }

  /** Saves the user's text for segments of a chunk and marks the chunk done (the flags were reviewed). */
  async editChunk(id: string, index: number, final: Record<string, string>): Promise<ChunkRecord> {
    if (this.runs.has(id)) throw new Error('pause the project before editing a chunk')
    const chunk = await this.store.readChunk(id, index)
    const known = new Set(chunk.segments.map((s) => s.id))
    for (const [segId, text] of Object.entries(final)) {
      if (!known.has(segId)) throw new Error(`chunk ${index} has no segment ${segId}`)
      chunk.final[segId] = text
    }
    chunk.state = 'done'
    chunk.qa = { issues: [] }
    chunk.error = undefined
    chunk.edited = true
    await this.store.writeChunk(id, chunk)
    this.emit({ type: 'chunk.state', projectId: id, index, state: 'done', model: chunk.model, tokens: chunk.tokens, issues: 0 })
    const project = await this.store.load(id)
    this.emit({ type: 'project.updated', project: summarize(project, await this.store.listChunks(id)) })
    return chunk
  }

  /** Replaces glossary.md. Chunks that start after this see the new entries. */
  async updateGlossary(id: string, entries: GlossaryEntry[]): Promise<void> {
    await this.store.writeGlossary(id, entries)
  }

  // ---- export ----

  /** The translated text per block id from the chunks. Blocks without a (complete) translation are left out, so they keep the source text. */
  async translations(id: string): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const parts = new Map<string, { total: number; texts: Map<number, string> }>()
    for (const chunk of await this.store.listChunks(id)) {
      for (const seg of chunk.segments) {
        const text = chunk.final[seg.id]
        if (text === undefined) continue
        if (seg.parts && seg.part) {
          const p = parts.get(seg.blockId) ?? { total: seg.parts, texts: new Map<number, string>() }
          p.texts.set(seg.part, text)
          parts.set(seg.blockId, p)
        } else map.set(seg.blockId, text)
      }
    }
    for (const [blockId, p] of parts) {
      if (p.texts.size !== p.total) continue
      map.set(blockId, [...p.texts.keys()].sort((a, b) => a - b).map((k) => p.texts.get(k)!.trim()).join(' '))
    }
    return map
  }

  /** Writes the translated document to output/. Works with partial progress. Returns the path. */
  async export(id: string, outPath?: string): Promise<string> {
    const project = await this.store.load(id)
    const ir = await this.store.readIr(id)
    const adapter = adapterFor(project.sourcePath) as unknown as AdapterExtras
    const ext = adapter.outputExt ?? path.extname(project.sourcePath)
    const lang = project.settings.targetLanguageCode ?? project.settings.targetLanguage
    const out = outPath ? path.resolve(outPath) : this.store.file(id, 'output', `${path.basename(project.sourcePath, path.extname(project.sourcePath))}.${lang}${ext}`)
    await fs.mkdir(path.dirname(out), { recursive: true })
    const translations = await this.translations(id)
    await adapter.write(ir, translations, project.sourcePath, out, { targetLanguage: lang })
    this.emit({ type: 'log', projectId: id, level: 'info', message: `exported ${translations.size} block(s) to ${out}` })
    return out
  }
}
