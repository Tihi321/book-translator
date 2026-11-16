import { chunkBudget, planChunks, SEG_OVERHEAD } from '../chunker'
import { countTokens } from '../tokens'
import { briefWithNote } from '../formats'
import type { ModelRegistry } from '../models/registry'
import type { ModelRouter } from '../models/router'
import { isAbortError } from '../models/types'
import { emptyChunk } from '../project/store'
import type { ProjectStore } from '../project/store'
import { countStates, summarize } from '../project/summary'
import { DEFAULT_PARALLEL, IN_PROGRESS_STATES, isClientRef, reviewerAgents } from '../../shared/project'
import type { DocumentIR } from '../../shared/ir'
import type { ChunkRecord, ChunkState, ProjectFile, ProjectSettings, Spend } from '../../shared/project'
import type { EngineEvent } from '../../shared/protocol'
import type { AgentName } from '../../shared/schemas'
import { ClientOnlyRefusal } from './env'
import type { AgentEnv, CallFn } from './env'
import { buildGlossary, mergeBriefText } from './glossary'
import { characterLabels, ensureNameEntries, isPlaceholderName, localizesNames } from './names'
import { proofreadChunk } from './proofreader'
import { fixChunk, reviewChunk } from './qa'
import { prevTail, translateChunk } from './translator'
import { effectiveTypography, typographyRuleOf } from './typography'

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
    const m = router.resolve(settings.agentModels[a] ?? [], { exact: settings.clientOnly === true })[0]
    if (m) contexts.push(registry.contextLength(m.ref))
  }
  return chunkBudget({ contexts, userMax: settings.maxChunkTokens })
}

/** How many chunks (or sections) run at once: 1 with parallel off, the translator provider's concurrency for `auto`, else `maxAtOnce` (1-16). */
export function workerCount(router: ModelRouter, settings: ProjectSettings): number {
  const par = { ...DEFAULT_PARALLEL, ...settings.parallel }
  if (!par.enabled) return 1
  if (par.maxAtOnce === 'auto') return Math.max(1, router.resolve(settings.agentModels.translator ?? [], { exact: settings.clientOnly === true })[0]?.provider.concurrency ?? 1)
  return Math.min(16, Math.max(1, Math.floor(Number(par.maxAtOnce)) || 1))
}

/**
 * Makes the chunk files of a project when there are none, or when every chunk is still pending and the budget changed (and `replan`).
 * Returns the chunks as they are on disk afterwards. Used by the runner and by `prepareChunks` (an outside translator).
 */
export async function planProjectChunks(store: ProjectStore, project: ProjectFile, ir: DocumentIR, budget: number, replan = true): Promise<{ chunks: ChunkRecord[]; planned: boolean }> {
  let chunks = await store.listChunks(project.id)
  const untouched = chunks.every((c) => c.state === 'pending' && !hasText(c.translation))
  if (chunks.length > 0 && !(untouched && project.chunking?.budget !== budget && replan)) return { chunks, planned: false }
  await store.clearChunks(project.id)
  chunks = planChunks(ir, budget).map(emptyChunk)
  for (const c of chunks) await store.writeChunk(project.id, c)
  project.chunking = { budget, chunks: chunks.length }
  await store.save(project)
  return { chunks, planned: true }
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
  c.editedSegs = undefined
}

const hasText = (r: Record<string, string>) => Object.keys(r).length > 0

/**
 * A chunk whose run was stopped (pause, cancel): back to pending. What a finished stage produced stays in the chunk file, so a resume
 * does not ask for it again (a client-only run answers every request by hand): the translation once the translator is through, the
 * proofread text once the proofreader is. A chunk stopped during the translator keeps the segments whose answers were accepted (the
 * first half of a split, a finished retry); the resume asks only for the others. A fix pass is not kept: it runs again.
 */
function parkChunk(c: ChunkRecord): void {
  if (c.state === 'translating') {
    c.state = 'pending'
    c.proofread = {}
    c.final = {}
    c.error = undefined
    c.edited = undefined
    c.editedSegs = undefined
    return
  }
  if (c.state !== 'proofreading' && c.state !== 'reviewing' && c.state !== 'fixing') return resetChunk(c)
  const proofDone = (c.state === 'reviewing' || c.state === 'fixing') && !c.error && hasText(c.proofread)
  if (!proofDone) c.proofread = {}
  c.state = 'pending'
  c.final = { ...(proofDone ? c.proofread : c.translation) }
  c.error = undefined // c.qa.issues still holds the translator's tag issues: the reviewer's verdict is only stored when the review ends
}

/**
 * Runs the pipeline for one project: glossary pre-pass, then the chunks. Work runs in parallel (`settings.parallel`, see `workerCount`):
 * sections side by side with the chunks of a section one after the other, or with `splitSections` every chunk on its own (a chunk then
 * gets the end of the previous chunk only when that one is already finished). The provider's concurrency and rpm still cap the requests. Stops at an abort (reason 'cancel' or anything else for pause) and
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
  /** The units (a section's chunks, or one chunk) no worker has taken yet, the workers running, and how many may run. */
  private queue: ChunkRecord[][] = []
  private workers = new Set<Promise<void>>()
  private alive = 0
  private target = 0
  private split = false
  private scheduling = false
  private fatal?: unknown

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
      await this.ensureNames(ir)
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
    const model = router.resolve(project.settings.agentModels.glossary ?? [], { exact: project.settings.clientOnly === true })[0]
    try {
      const localize = localizesNames(project)
      // a name entry that only keeps the name (from before the setting was turned on) is left for the builder to localize
      const existing = localize ? env.glossary.filter((e) => !isPlaceholderName(e)) : env.glossary
      const res = await buildGlossary(env, ir, { contexts: model ? [registry.contextLength(model.ref)] : [], existing, localizeNames: localize ? characterLabels(ir) : undefined })
      await store.writeGlossary(project.id, res.entries)
      await this.ensureNames(ir)
      const hasBrief = res.brief.characters.length > 0 || [res.brief.genre, res.brief.tone, res.brief.register, res.brief.pov, res.brief.address].some(Boolean)
      // a brief the user wrote (set_brief, or edited by hand) keeps all its text: the pass only adds what is missing
      if (hasBrief) await store.writeBrief(project.id, mergeBriefText(await store.readBrief(project.id), res.brief))
      // typography: the brief says how dialogue is marked; when it is empty the target language's default is written here (the user can change it)
      if (!project.settings.typography?.dialogue) {
        const t = effectiveTypography(project.settings)
        if (t) project.settings.typography = t
      }
      project.glossaryDone = true
      await store.save(project)
      this.log(res.failed > 0 ? 'warn' : 'info', `glossary built: ${res.entries.length} terms in ${res.passes} pass(es)${res.failed > 0 ? `, ${res.failed} of them failed and were skipped` : ''}`)
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

  /** With `localizeNames`: every character name gets a glossary entry (the builder's form, or the name itself to edit). */
  private async ensureNames(ir: DocumentIR): Promise<void> {
    if (!localizesNames(this.project)) return
    const added = await ensureNameEntries(this.deps.store, this.projectId, ir)
    if (added > 0) this.log('info', `${added} character name(s) have no localized form in the glossary yet: they keep the source name until you change Target in glossary.md`)
  }

  // ---- chunks ----

  private async prepareChunks(ir: Awaited<ReturnType<ProjectStore['readIr']>>, opts: RunOptions): Promise<void> {
    const { store, registry, router } = this.deps
    const project = this.project
    if (!router.resolve(project.settings.agentModels.translator ?? [], { exact: project.settings.clientOnly === true })[0]) throw new Error(`no usable translator model in: ${(project.settings.agentModels.translator ?? []).join(', ') || '(none)'}`)
    const budget = budgetFor(registry, router, project.settings)
    const { chunks, planned } = await planProjectChunks(store, project, ir, budget, !opts.only)
    if (planned) this.log('info', `${chunks.length} chunks of up to ${budget} tokens`)
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
    const split = this.project.settings.parallel?.splitSections === true
    // a unit is what one worker runs from start to end: a section's chunks in order, or (split) one chunk
    const units: ChunkRecord[][] = []
    if (split) for (const c of todo) units.push([c])
    else {
      const sections = new Map<string, ChunkRecord[]>()
      for (const c of todo) {
        const list = sections.get(c.sectionId) ?? []
        list.push(c)
        sections.set(c.sectionId, list)
      }
      units.push(...sections.values())
    }
    this.queue = units
    this.target = workerCount(router, this.project.settings)
    this.split = split
    this.fatal = undefined
    this.scheduling = true
    try {
      for (let i = Math.min(this.target, this.queue.length); i > 0; i--) this.spawn()
      // workers that `configReloaded` adds join the set while it is awaited
      while (this.workers.size > 0) await Promise.all([...this.workers])
    } finally {
      this.scheduling = false
    }
    if (this.fatal) throw this.fatal
  }

  /** Starts one worker on the shared queue. */
  private spawn(): void {
    this.alive++
    const p: Promise<void> = this.work()
      .catch((err: unknown) => {
        if (!isAbortError(err)) this.fatal ??= err
      })
      .finally(() => void this.workers.delete(p))
    this.workers.add(p)
  }

  /** One worker: takes units from the queue until it is empty, the run is aborted, or the worker count went down. */
  private async work(): Promise<void> {
    let left = false
    const leave = () => {
      if (!left) {
        left = true
        this.alive--
      }
    }
    try {
      for (;;) {
        // the worker count went down in a reload: this worker stops (checked and counted in one step, so no more stop than needed)
        if (this.alive > this.target) return leave()
        const unit = this.queue.shift()
        if (!unit || this.signal?.aborted) return
        for (const chunk of unit) {
          if (this.signal?.aborted) return
          const at = this.chunks.indexOf(chunk)
          const before = this.chunks[at - 1]
          // split: the previous chunk may be running right now, so only a finished one gives its end as context
          const finished = before && (before.state === 'done' || before.state === 'flagged')
          await this.runChunk(chunk, before && before.sectionId === chunk.sectionId && (!this.split || finished) ? before : undefined)
        }
      }
    } finally {
      leave()
    }
  }

  /**
   * A providers reload happened. A running project follows it with the number of workers (more start on the queue, fewer after
   * their current section or chunk) and says when the new chunk budget no longer fits the plan. The plan itself stays: re-planning
   * would renumber chunk files that finished chunks, the UI and an outside translator refer to. Does nothing before the chunks are
   * prepared (the glossary stage): the stage after it reads the reloaded providers anyway.
   */
  configReloaded(): void {
    const { registry, router } = this.deps
    if (this.chunks.length === 0) return
    if (this.scheduling && !this.signal?.aborted) {
      this.target = workerCount(router, this.project.settings)
      for (let i = Math.min(this.target - this.alive, this.queue.length); i > 0; i--) this.spawn()
    }
    const planned = this.project.chunking?.budget
    const budget = budgetFor(registry, router, this.project.settings)
    const pending = this.queue.flat()
    if (planned === undefined || pending.length === 0 || budget === planned) return
    if (budget < planned) {
      const large = pending.filter((c) => c.segments.reduce((n, s) => n + countTokens(s.text) + SEG_OVERHEAD, 0) > budget).length
      if (large > 0) this.log('warn', `${large} pending chunk(s) are larger than the new chunk budget (${budget} tokens, the plan used ${planned}). They keep the plan; a model too small for one hands it to the next model in its list.`)
    } else this.log('info', `the chunk budget grew to ${budget} tokens: the plan keeps chunks of up to ${planned} tokens; a project with no chunk started re-plans at its next start`)
  }

  private async runChunk(chunk: ChunkRecord, prev: ChunkRecord | undefined): Promise<void> {
    const { store, emit } = this.deps
    try {
      await this.processChunk(chunk, prev)
    } catch (err) {
      if (this.signal?.aborted || isAbortError(err)) {
        parkChunk(chunk)
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
    // a chunk parked by a pause keeps the output of the stages that finished: carry on after them
    const parked = chunk.state === 'pending' && hasText(chunk.translation)
    const translated = parked && segs.every((s) => Object.hasOwn(chunk.translation, s.id))
    const resumed = translated
    const proofDone = resumed && hasText(chunk.proofread)
    if (resumed) {
      chunk.error = undefined
      chunk.edited = undefined
      chunk.editedSegs = undefined
      this.log('info', `chunk ${chunk.index} resumes after its ${proofDone ? 'proofreading' : 'translation'}`)
    } else {
      if (parked) {
        // stopped inside the translator: the accepted segments stay, only the others are asked for
        chunk.error = undefined
        chunk.edited = undefined
        chunk.editedSegs = undefined
        chunk.final = {}
        chunk.proofread = {}
        this.log('info', `chunk ${chunk.index} resumes the translation: ${Object.keys(chunk.translation).length} of ${segs.length} segments kept`)
      } else resetChunk(chunk)
      await this.setState(chunk, 'translating')
      const tr = await translateChunk(env, segs, { prev: prev ? prevTail(prev.segments, prev.final) : undefined, unit }, chunk.translation)
      chunk.translation = tr.translation
      chunk.final = { ...tr.translation }
      chunk.qa.issues = tr.issues
    }

    if (settings.enabled.proofreader && !proofDone) {
      await this.setState(chunk, 'proofreading')
      const pr = await proofreadChunk(env, segs, chunk.translation, { unit })
      chunk.proofread = pr.proofread
      chunk.final = { ...pr.proofread }
      if (pr.refused) chunk.error = pr.refused // the translation is kept; the chunk is flagged below, like a refused QA
    }

    if (settings.enabled.qa) {
      await this.setState(chunk, 'reviewing')
      let review = await reviewChunk(env, segs, chunk.final, { unit })
      let issues = review.issues
      const bad = new Set((settings.fixMinorIssues === true ? issues : issues.filter(isMajor)).map((i) => i.segId))
      if (bad.size > 0) {
        await this.setState(chunk, 'fixing')
        const fixed = await fixChunk(env, segs, chunk.final, issues.filter((i) => bad.has(i.segId)), { unit })
        chunk.final = { ...chunk.final, ...fixed }
        await this.setState(chunk, 'reviewing')
        review = await reviewChunk(env, segs, chunk.final, { unit, task: 'recheck' })
        issues = review.issues
      }
      if (review.refused) chunk.error = chunk.error ? `${chunk.error}; ${review.refused}` : review.refused // shown as the chunk's reason; the QA is skipped, so the chunk is flagged below
      chunk.qa = { issues, ...(review.score !== undefined ? { score: review.score } : {}), ...(review.model ? { model: review.model } : {}) }
    }

    await this.setState(chunk, chunk.qa.issues.some(isMajor) || chunk.error ? 'flagged' : 'done')
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
      brief: briefWithNote(brief, this.project.format, { localizeNames: localizesNames(this.project), typography: typographyRuleOf(this.project.settings) }),
      glossary,
      format: this.project.format,
      call: this.makeCall(chunk),
      models: (agent) => this.ownModels(agent),
      log: (level, message) => this.log(level, message),
      signal: this.signal
    }
  }

  /** The project's own model list for an agent: `agentModels[agent]` with the translator model first. */
  private ownRefs(agent: AgentName): string[] {
    const base = this.project.settings.agentModels[agent] ?? []
    return agent === 'translator' && this.translatorModel ? [this.translatorModel, ...base.filter((r) => r !== this.translatorModel)] : base
  }

  /** The own list resolved, deduplicated and available, without the registry's shared fallback rows. */
  private ownModels(agent: AgentName): string[] {
    return this.deps.router.resolve(this.ownRefs(agent), { exact: true }).map((m) => m.ref)
  }

  private makeCall(chunk: ChunkRecord | null): CallFn {
    return async (agent, req, hooks) => {
      const refs = this.ownRefs(agent)
      // the one place every model call passes: a client-only project never reaches a model that is not the client's
      const clientOnly = this.project.settings.clientOnly === true
      if (clientOnly) {
        // a reviewer's free models (local providers) are allowed for the agents the reviewer setting names, nothing else
        const isReviewer = reviewerAgents(this.project.settings).includes(agent)
        const reviewerRefs = isReviewer ? (this.project.settings.reviewer?.models ?? []) : []
        // client/claude-code translates, so it never reviews; another client/ model or a local provider's model may
        const outside = refs.filter((r) => !(isReviewer ? reviewerRefs.includes(r) && r !== 'client/claude-code' && (isClientRef(r) || this.deps.registry.isLocalRef(r)) : isClientRef(r)))
        if (outside.length) {
          throw new ClientOnlyRefusal(
            agent === 'qa'
              ? `reviewer ${outside.join(', ')} refused: not free in a client-only project (only another client/ model or a local provider's model; client/claude-code translates). Fix it with update_project_settings.`
              : agent === 'proofreader'
                ? `proofreader ${outside.join(', ')} refused: not free in a client-only project (only a client/ model, or a local provider's model named in reviewer with proofread true). Fix it with update_project_settings.`
                : `project is client-only: the ${agent} agent may not use ${outside.join(', ')} (only client/ models). Turn clientOnly off with update_project_settings to use it.`
          )
        }
      }
      // after a mismatch on some models: start at the next own model; a provider error on it still falls back as before
      const skip = new Set(req.skipModels ?? [])
      const lead = skip.size > 0 ? this.ownModels(agent).filter((m) => !skip.has(m)) : []
      const rotation = lead.length > 0 ? { lead, skip: req.skipModels } : {}
      const r = await this.deps.router.complete(
        refs,
        { messages: req.messages, schema: req.schema, maxTokens: req.maxTokens, temperature: req.temperature, signal: this.signal, exact: clientOnly, ...rotation, meta: { role: agent, task: req.task, project: this.projectId, unit: req.unit, job: [this.projectId, req.unit ?? 'run', req.task ?? 'call'].join('--') } },
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
      } else this.emitProgress() // calls outside a chunk (the glossary) would otherwise show no spend until the stage ends
      return { text: r.text, costUsd: r.costUsd, model: r.model.ref, usage: r.usage, ms: r.ms }
    }
  }

  private async setState(chunk: ChunkRecord, state: ChunkState): Promise<void> {
    chunk.state = state
    this.flushTokens(chunk)
    await this.deps.store.writeChunk(this.project.id, chunk)
    this.deps.emit({ type: 'chunk.state', projectId: this.project.id, index: chunk.index, state, model: chunk.model, tokens: chunk.tokens, issues: chunk.qa.issues.length, ...(chunk.qa.score !== undefined ? { qaScore: chunk.qa.score } : {}) })
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
