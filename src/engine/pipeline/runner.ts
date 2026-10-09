import { chunkBudget, planChunks } from '../chunker'
import type { ModelRegistry } from '../models/registry'
import type { ModelRouter } from '../models/router'
import { isAbortError } from '../models/types'
import { emptyChunk } from '../project/store'
import type { ProjectStore } from '../project/store'
import { countStates, summarize } from '../project/summary'
import { IN_PROGRESS_STATES } from '../../shared/project'
import type { ChunkRecord, ChunkState, ProjectFile, ProjectSettings, Spend } from '../../shared/project'
import type { EngineEvent } from '../../shared/protocol'
import type { AgentEnv, CallFn } from './env'
import { buildGlossary, serializeBrief } from './glossary'
import { proofreadChunk } from './proofreader'
import { fixChunk, reviewChunk } from './qa'
import { prevTail, translateChunk } from './translator'

export interface RunnerDeps {
  dataDir: string
  registry: ModelRegistry
  router: ModelRouter
  store: ProjectStore
  emit: (ev: EngineEvent) => void
}

export interface RunOptions {
  signal?: AbortSignal
  /** Run only these chunks (1-based), after resetting them. Used to retry a chunk. */
  only?: number[]
  /** A model to try first for the translator (retry with another model). */
  translatorModel?: string
}

export type RunStatus = 'done' | 'incomplete' | 'paused' | 'cancelled' | 'glossary-review'

export interface RunResult {
  status: RunStatus
  counts: Record<ChunkState, number>
  spend: Spend
}

/** The chunk budget (source tokens) for a project: the smallest context among the first usable model of each enabled chunk agent. */
export function budgetFor(registry: ModelRegistry, router: ModelRouter, settings: ProjectSettings): number {
  const agents = (['translator', 'proofreader', 'qa'] as const).filter((a) => a === 'translator' || settings.enabled[a])
  const contexts: number[] = []
  for (const a of agents) {
    const m = router.resolve(settings.agentModels[a] ?? [])[0]
    if (m) contexts.push(registry.contextLength(m.ref))
  }
  return chunkBudget({ contexts, userMax: settings.maxChunkTokens })
}

const isMajor = (i: { severity: string }) => i.severity === 'major'

function resetChunk(c: ChunkRecord): void {
  c.state = 'pending'
  c.translation = {}
  c.proofread = {}
  c.final = {}
  c.qa = { issues: [] }
  c.error = undefined
  c.edited = undefined
}

/**
 * Runs the pipeline for one project: glossary pre-pass, then the chunks. Sections run in parallel up to the translator provider's
 * concurrency, the chunks of a section one after the other. Stops at an abort (reason 'cancel' or anything else for pause) and
 * can be started again: chunks in done/flagged are skipped, in-progress and failed ones start over.
 */
export class ProjectRunner {
  private project!: ProjectFile
  private chunks: ChunkRecord[] = []
  private signal?: AbortSignal
  private translatorModel?: string
  private startedAt = 0
  private finishedThisRun = 0
  private tokenBuf = new Map<number, { text: string; last: number }>()

  constructor(
    private readonly deps: RunnerDeps,
    readonly projectId: string
  ) {}

  async run(opts: RunOptions = {}): Promise<RunResult> {
    const { store } = this.deps
    this.project = await store.load(this.projectId)
    this.signal = opts.signal
    this.translatorModel = opts.translatorModel
    this.startedAt = Date.now()
    this.finishedThisRun = 0
    const ir = await store.readIr(this.projectId)
    const settings = this.project.settings
    try {
      if (settings.enabled.glossary && !this.project.glossaryDone && !opts.only) {
        const stop = await this.glossaryStage(ir)
        if (stop) return this.result('glossary-review')
      }
      await this.setProjectStatus('translating')
      await this.prepareChunks(ir, opts)
      await this.schedule(opts)
    } catch (err) {
      if (!(this.signal?.aborted || isAbortError(err))) {
        await this.setProjectStatus('incomplete')
        throw err
      }
    }
    if (this.signal?.aborted && !opts.only) {
      const status = this.signal.reason === 'cancel' ? 'cancelled' : 'paused'
      await this.setProjectStatus(status)
      return this.result(status)
    }
    const counts = countStates(this.chunks)
    const status = counts.pending + counts.failed + IN_PROGRESS_STATES.reduce((n, s) => n + counts[s], 0) === 0 ? 'done' : 'incomplete'
    await this.setProjectStatus(status)
    return this.result(status)
  }

  private result(status: RunStatus): RunResult {
    return { status, counts: countStates(this.chunks), spend: { ...this.project.spend } }
  }

  // ---- glossary ----

  private async glossaryStage(ir: Awaited<ReturnType<ProjectStore['readIr']>>): Promise<boolean> {
    const { store, router, registry } = this.deps
    const project = this.project
    await this.setProjectStatus('glossary')
    const env = await this.makeEnv(null)
    const model = router.resolve(project.settings.agentModels.glossary ?? [])[0]
    try {
      const res = await buildGlossary(env, ir, { contexts: model ? [registry.contextLength(model.ref)] : [], existing: env.glossary })
      await store.writeGlossary(project.id, res.entries)
      const hasBrief = res.brief.characters.length > 0 || [res.brief.genre, res.brief.tone, res.brief.register, res.brief.pov, res.brief.address].some(Boolean)
      if (hasBrief) await store.writeBrief(project.id, serializeBrief(res.brief))
      project.glossaryDone = true
      await store.save(project)
      this.log('info', `glossary built: ${res.entries.length} terms in ${res.passes} pass(es)`)
    } catch (err) {
      if (this.signal?.aborted || isAbortError(err)) throw err
      this.log('error', `glossary builder failed, translating without it: ${(err as Error).message}`)
      this.deps.emit({ type: 'error', projectId: project.id, message: `Glossary builder failed: ${(err as Error).message}` })
      return false
    }
    if (project.settings.pauseAfterGlossary) {
      await this.setProjectStatus('glossary-review')
      this.log('info', 'glossary ready, waiting for review (start again to continue)')
      return true
    }
    return false
  }

  // ---- chunks ----

  private async prepareChunks(ir: Awaited<ReturnType<ProjectStore['readIr']>>, opts: RunOptions): Promise<void> {
    const { store, registry, router } = this.deps
    const project = this.project
    if (!router.resolve(project.settings.agentModels.translator ?? [])[0]) throw new Error(`no usable translator model in: ${(project.settings.agentModels.translator ?? []).join(', ') || '(none)'}`)
    let chunks = await store.listChunks(project.id)
    const untouched = chunks.every((c) => c.state === 'pending')
    const budget = budgetFor(registry, router, project.settings)
    if (chunks.length === 0 || (untouched && project.chunking?.budget !== budget && !opts.only)) {
      await store.clearChunks(project.id)
      chunks = planChunks(ir, budget).map(emptyChunk)
      for (const c of chunks) await store.writeChunk(project.id, c)
      project.chunking = { budget, chunks: chunks.length }
      await store.save(project)
      this.log('info', `${chunks.length} chunks of up to ${budget} tokens`)
    }
    for (const c of chunks) {
      const retry = opts.only ? opts.only.includes(c.index) : c.state === 'failed' || IN_PROGRESS_STATES.includes(c.state)
      if (retry) {
        resetChunk(c)
        await store.writeChunk(project.id, c)
      }
    }
    this.chunks = chunks
    this.emitProgress()
  }

  private async schedule(opts: RunOptions): Promise<void> {
    const { router } = this.deps
    const todo = this.chunks.filter((c) => c.state === 'pending' && (!opts.only || opts.only.includes(c.index)))
    const sections = new Map<string, ChunkRecord[]>()
    for (const c of todo) {
      const list = sections.get(c.sectionId) ?? []
      list.push(c)
      sections.set(c.sectionId, list)
    }
    const queue = [...sections.values()]
    const concurrency = Math.max(1, router.resolve(this.project.settings.agentModels.translator ?? [])[0]?.provider.concurrency ?? 1)
    const worker = async () => {
      for (;;) {
        const section = queue.shift()
        if (!section || this.signal?.aborted) return
        for (const chunk of section) {
          if (this.signal?.aborted) return
          const at = this.chunks.indexOf(chunk)
          const before = this.chunks[at - 1]
          await this.runChunk(chunk, before && before.sectionId === chunk.sectionId ? before : undefined)
        }
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    const fatal = results.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !isAbortError(r.reason))
    if (fatal) throw fatal.reason
  }

  private async runChunk(chunk: ChunkRecord, prev: ChunkRecord | undefined): Promise<void> {
    const { store, emit } = this.deps
    try {
      await this.processChunk(chunk, prev)
    } catch (err) {
      if (this.signal?.aborted || isAbortError(err)) {
        resetChunk(chunk)
        await store.writeChunk(this.project.id, chunk).catch(() => undefined)
        throw err
      }
      chunk.state = 'failed'
      chunk.error = (err as Error).message
      this.flushTokens(chunk)
      await store.writeChunk(this.project.id, chunk)
      this.log('error', `chunk ${chunk.index} failed: ${chunk.error}`)
      emit({ type: 'chunk.state', projectId: this.project.id, index: chunk.index, state: 'failed', model: chunk.model, tokens: chunk.tokens })
    }
    this.finishedThisRun++
    await store.save(this.project)
    this.emitProgress()
  }

  private async processChunk(chunk: ChunkRecord, prev: ChunkRecord | undefined): Promise<void> {
    const settings = this.project.settings
    const unit = `chunk-${chunk.index}`
    const env = await this.makeEnv(chunk)
    const segs = chunk.segments
    resetChunk(chunk)
    await this.setState(chunk, 'translating')
    const tr = await translateChunk(env, segs, { prev: prev ? prevTail(prev.segments, prev.final) : undefined, unit }, chunk.translation)
    chunk.translation = tr.translation
    chunk.final = { ...tr.translation }
    chunk.qa.issues = tr.issues

    if (settings.enabled.proofreader) {
      await this.setState(chunk, 'proofreading')
      const pr = await proofreadChunk(env, segs, chunk.translation, { unit })
      chunk.proofread = pr.proofread
      chunk.final = { ...pr.proofread }
    }

    if (settings.enabled.qa) {
      await this.setState(chunk, 'reviewing')
      let issues = await reviewChunk(env, segs, chunk.final, { unit })
      const bad = new Set(issues.filter(isMajor).map((i) => i.segId))
      if (bad.size > 0) {
        await this.setState(chunk, 'fixing')
        const fixed = await fixChunk(env, segs, chunk.final, issues.filter((i) => bad.has(i.segId)), { unit })
        chunk.final = { ...chunk.final, ...fixed }
        await this.setState(chunk, 'reviewing')
        issues = await reviewChunk(env, segs, chunk.final, { unit, task: 'recheck' })
      }
      chunk.qa.issues = issues
    }

    await this.setState(chunk, chunk.qa.issues.some(isMajor) ? 'flagged' : 'done')
  }

  // ---- plumbing ----

  private async makeEnv(chunk: ChunkRecord | null): Promise<AgentEnv> {
    const { store, dataDir } = this.deps
    const [glossary, brief] = await Promise.all([store.readGlossary(this.projectId), store.readBrief(this.projectId)])
    const s = this.project.settings
    return {
      dataDir,
      sourceLanguage: s.sourceLanguage ?? 'the original language',
      targetLanguage: s.targetLanguage,
      brief,
      glossary,
      call: this.makeCall(chunk),
      log: (level, message) => this.log(level, message),
      signal: this.signal
    }
  }

  private makeCall(chunk: ChunkRecord | null): CallFn {
    return async (agent, req, hooks) => {
      const base = this.project.settings.agentModels[agent] ?? []
      const refs = agent === 'translator' && this.translatorModel ? [this.translatorModel, ...base.filter((r) => r !== this.translatorModel)] : base
      const r = await this.deps.router.complete(
        refs,
        { messages: req.messages, schema: req.schema, maxTokens: req.maxTokens, temperature: req.temperature, signal: this.signal, meta: { role: agent, task: req.task, project: this.projectId, unit: req.unit } },
        {
          onDelta: (t) => {
            hooks?.onDelta?.(t)
            if (chunk) this.token(chunk, t)
          }
        }
      )
      const spend = this.project.spend
      spend.tokensIn += r.usage.inputTokens
      spend.tokensOut += r.usage.outputTokens
      spend.costUsd += r.costUsd
      spend.ms += r.ms
      if (chunk) {
        chunk.tokens.in += r.usage.inputTokens
        chunk.tokens.out += r.usage.outputTokens
        chunk.costUsd += r.costUsd
        chunk.ms += r.ms
        if (agent === 'translator') chunk.model = r.model.ref
      }
      return { text: r.text, costUsd: r.costUsd, model: r.model.ref, usage: r.usage, ms: r.ms }
    }
  }

  private async setState(chunk: ChunkRecord, state: ChunkState): Promise<void> {
    chunk.state = state
    this.flushTokens(chunk)
    await this.deps.store.writeChunk(this.project.id, chunk)
    this.deps.emit({ type: 'chunk.state', projectId: this.project.id, index: chunk.index, state, model: chunk.model, tokens: chunk.tokens, issues: chunk.qa.issues.length })
    this.emitProgress()
  }

  /** Live text, at most one event per ~100 ms per chunk. */
  private token(chunk: ChunkRecord, text: string): void {
    const b = this.tokenBuf.get(chunk.index) ?? { text: '', last: 0 }
    b.text += text
    const now = Date.now()
    if (now - b.last >= 100) {
      this.deps.emit({ type: 'chunk.token', projectId: this.project.id, index: chunk.index, stage: chunk.state, text: b.text })
      b.text = ''
      b.last = now
    }
    this.tokenBuf.set(chunk.index, b)
  }

  private flushTokens(chunk: ChunkRecord): void {
    const b = this.tokenBuf.get(chunk.index)
    if (b?.text) this.deps.emit({ type: 'chunk.token', projectId: this.project.id, index: chunk.index, stage: chunk.state, text: b.text })
    this.tokenBuf.delete(chunk.index)
  }

  private emitProgress(): void {
    const perStage = countStates(this.chunks)
    const total = this.chunks.length
    const done = perStage.done + perStage.flagged
    const remaining = total - done - perStage.failed
    const elapsed = (Date.now() - this.startedAt) / 1000
    const etaSec = this.finishedThisRun > 0 ? Math.round((elapsed / this.finishedThisRun) * Math.max(0, remaining)) : null
    const sp = this.project.spend
    this.deps.emit({ type: 'progress', projectId: this.project.id, done, total, perStage, tokensIn: sp.tokensIn, tokensOut: sp.tokensOut, costUsd: sp.costUsd, etaSec })
  }

  private async setProjectStatus(status: ProjectFile['status']): Promise<void> {
    this.project.status = status
    await this.deps.store.save(this.project)
    this.deps.emit({ type: 'project.updated', project: summarize(this.project, this.chunks) })
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.emit({ type: 'log', projectId: this.projectId, level, message })
    void this.deps.store.log(this.projectId, `${level}: ${message}`)
  }
}
