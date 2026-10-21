import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { EngineBus } from '../bus'
import type { CommandDispatcher } from '../dispatcher'
import { NOTHING_LEFT } from '../service'
import type { EngineService } from '../service'
import { countStates } from '../project/summary'
import type { EngineEvent, ModelsInfo, ProgressInfo } from '../../shared/protocol'
import type { Command } from '../../shared/protocol'
import type { ProjectFile } from '../../shared/project'
import { AGENTS } from '../../shared/schemas'

/** The longest `wait_for_progress` waits, and the wait when `timeoutSec` is left out. */
export const MAX_WAIT_SEC = 60
const DEFAULT_WAIT_SEC = 25
/** Lines of log.md that `get_project` returns. */
const LOG_LINES = 40

const INSTRUCTIONS = `Book Translator translates books (EPUB, DOCX, TXT, MD, PDF, and Scriptorium visual-novel book folders) chunk by chunk, with a glossary and a brief for consistency.

Three ways to work:

1. Operator: the app's own models translate. analyze_file, create_project (pick models with list_models and agentModels), start_translation, then wait_for_progress until the status is done (paused: start_translation again to resume), look at chunks that came back flagged or failed (get_project, get_chunk, edit_chunk, retry_chunk), then export_project. Models of paid providers cost money: check analyze_file's estimate first.

2. Translator: you translate, the app's models are not used and nothing is spent. create_project with enabledAgents all false, then prepare_chunks. Optionally write a glossary (update_glossary) and a brief (set_brief) first. Then repeat get_translation_task and submit_translation until get_translation_task says nothing is left. A submission whose segment ids or inline tags (<1>, </1>, <2/>) do not match is rejected with the reason: fix it and submit again. Finish with export_project. The prompt translate_book_yourself has the full loop. This path does the first pass only: no glossary builder, proofreader or QA.

3. Full pipeline, you answer the app's model calls: create_project (or update_project_settings) with clientOnly true: all four agents (glossary, translator, proofreader, qa) go on client/claude-code and the project refuses every other model, so a paid or local model can never be called by mistake; start_translation, then repeat wait_for_progress (it returns at once when a request waits: clientTasks.waiting) and get_client_task, answer as its output says, and submit_client_task. A JSON answer (glossary, QA) is checked against its schema when submitted. Nothing is spent. The client provider is in config/providers.md, enabled in the seed; a data folder that already exists needs it added by hand (see the README). Put the project back on real models afterwards (clientOnly false and agentModels), or it waits for a client for ever. The prompt translate_with_full_pipeline has the loop.

Visual-novel book folder: give the folder (book.md, outline.md, chapters/, bible/bible.md, cover-brief.md) as sourcePath. Every script line is one segment and the export is a folder of the same layout with the same lines: SCENE:, ON SCREEN: and speaker tags stay, a spoken line comes as <1>NAME (expression):</1> text (keep the tag, translate the text), the bible and cover brief are copied. VN Studio can add the exported folder as an edition (vno_add_edition).

Paths are on the machine the app runs on. Projects are named after the file, the language and a hash, so the same file and language give the same project.`

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const fail = (err: unknown) => ({ isError: true as const, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] })

const projectId = z.string().min(1).describe('The project id (see list_projects)')
const agentNames = z.enum(AGENTS)
const agentModels = z.partialRecord(agentNames, z.array(z.string())).describe('Per agent (glossary, translator, proofreader, qa): ordered provider/model refs, the first is used, the rest are fallbacks').optional()
const enabledAgents = z
  .object({ glossary: z.boolean().optional(), proofreader: z.boolean().optional(), qa: z.boolean().optional() })
  .describe('Which optional agents run. The translator always runs')
  .optional()

const clientOnly = z
  .boolean()
  .describe('true: only client/claude-code (you, the MCP client) answers every model call of the project, nothing is spent. Sets all four agents to client/claude-code (any agentModels given with it is ignored) and refuses every other model, retry_chunk model included. false: turns it off, the agents stay on client/claude-code until you set agentModels.')
  .optional()

/** What a model list needs: not every field of the picker's entries. */
function trimModels(info: ModelsInfo) {
  return info.models.map((m) => ({ ref: m.ref, available: m.available, local: m.local, context: m.context, priceInPer1M: m.priceIn, priceOutPer1M: m.priceOut }))
}

/** Drops the keys whose value is undefined, so a patch only carries what the caller set. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * The MCP server: tools that call `dispatcher.handle`, the same path the app's UI uses. Left out on purpose: API keys, provider settings,
 * model limits and deleting projects. A tool that fails answers with `isError: true` and the engine's message.
 */
export function createMcpServer(dispatcher: CommandDispatcher, service: EngineService, bus: EngineBus): McpServer {
  const server = new McpServer({ name: 'book-translator', version: '0.0.1' }, { instructions: INSTRUCTIONS })
  const run = (cmd: Command) => dispatcher.handle(cmd)

  /** Registers a tool whose handler returns data (turned into JSON text) or a ready result. */
  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, readOnly = false) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        const out = await fn(args)
        return typeof out === 'object' && out !== null && 'content' in out ? out : text(out)
      } catch (err) {
        return fail(err)
      }
    }) as never)
  }

  // ---- info and models ----

  tool('get_info', 'The data folder, the supported file extensions, and whether the scripted mock models are shown.', {}, () => run({ type: 'getInfo' }), true)
  tool('list_models', 'The models the agents can use: ref (provider/model), whether it is available now, context window, price per 1M tokens (0 for local).', {}, async () => trimModels((await run({ type: 'listModels' })) as ModelsInfo), true)
  tool('get_defaults', 'Default models per agent, default chunk size and parallel settings used for new projects.', {}, async () => {
    const { languages: _languages, ...rest } = (await run({ type: 'getDefaults' })) as { languages: unknown[] }
    return rest
  }, true)
  tool('list_languages', 'The target languages the app knows by code and name. Any other name works too.', {}, async () => ((await run({ type: 'getDefaults' })) as { languages: unknown[] }).languages, true)

  // ---- projects ----

  tool('list_projects', 'All projects with status, chunk counts and spend.', {}, () => service.listProjects(), true)
  tool(
    'analyze_file',
    'Reads a document and estimates chunks, tokens, cost and time with the default (or given) settings. Creates nothing.',
    { sourcePath: z.string().describe('Absolute path of the book, or of a visual-novel book folder'), targetLanguage: z.string().optional(), sourceLanguage: z.string().optional() },
    (a) => run({ type: 'analyze', sourcePath: a.sourcePath, targetLanguage: a.targetLanguage, sourceLanguage: a.sourceLanguage }),
    true
  )
  tool(
    'create_project',
    'Creates a project for a book and a target language (or returns the one that exists for that file and language, with its settings updated). Defaults come from get_defaults. To translate it yourself, set enabledAgents to all false. For a Claude-only translation of the full pipeline set clientOnly true.',
    {
      sourcePath: z.string().describe('Absolute path of the book, or of a Scriptorium visual-novel book folder (exported as a folder)'),
      targetLanguage: z.string().describe('Name or code, for example Croatian or hr'),
      sourceLanguage: z.string().optional(),
      agentModels,
      enabledAgents,
      clientOnly,
      maxChunkTokens: z.number().int().min(100).optional().describe('Upper limit of a chunk in source tokens'),
      projectId: z.string().optional().describe('A project id of your own (default: made from the file name, language and hash)')
    },
    (a) =>
      run({
        type: 'createProject',
        sourcePath: a.sourcePath,
        targetLanguage: a.targetLanguage,
        sourceLanguage: a.sourceLanguage,
        id: a.projectId,
        settings: defined({ agentModels: a.agentModels as never, enabled: a.enabledAgents as never, maxChunkTokens: a.maxChunkTokens, clientOnly: a.clientOnly })
      })
  )
  tool(
    'get_project',
    `The project's settings, status, chunk list (state, issues), glossary, brief and the last ${LOG_LINES} log lines, and clientTasks: how many requests of this project wait for you (waiting) or are leased (leased) on the client provider.`,
    { projectId },
    async (a) => {
      const detail = (await run({ type: 'getProject', projectId: a.projectId })) as { log: string }
      return { ...detail, clientTasks: clientCounts(service, a.projectId), log: detail.log.split('\n').slice(-LOG_LINES).join('\n') }
    },
    true
  )
  tool(
    'update_project_settings',
    'Changes models, agents on or off, chunk size or language of a project. Refused while it runs.',
    {
      projectId,
      agentModels,
      enabledAgents,
      clientOnly,
      maxChunkTokens: z.number().int().min(100).optional(),
      targetLanguage: z.string().optional(),
      sourceLanguage: z.string().optional(),
      pauseAfterGlossary: z.boolean().optional(),
      parallel: z.object({ enabled: z.boolean().optional(), maxAtOnce: z.union([z.literal('auto'), z.number().int().min(1).max(16)]).optional(), splitSections: z.boolean().optional() }).optional()
    },
    (a) =>
      run({
        type: 'updateProjectSettings',
        projectId: a.projectId,
        patch: defined({
          agentModels: a.agentModels as never,
          enabled: a.enabledAgents as never,
          clientOnly: a.clientOnly,
          maxChunkTokens: a.maxChunkTokens,
          targetLanguage: a.targetLanguage,
          sourceLanguage: a.sourceLanguage,
          pauseAfterGlossary: a.pauseAfterGlossary,
          parallel: a.parallel as never
        })
      })
  )

  // ---- running ----

  tool('start_translation', "Starts the project with the app's models, or resumes it where it stopped. Returns at once: follow it with wait_for_progress.", { projectId }, async (a) => {
    await run({ type: 'start', projectId: a.projectId })
    return { started: true, projectId: a.projectId }
  })
  tool('pause_translation', 'Stops a running project after cancelling the requests in flight. Start it again to resume.', { projectId }, async (a) => {
    await run({ type: 'pause', projectId: a.projectId })
    return { paused: true }
  })
  tool('cancel_translation', 'Stops a running project and marks it cancelled. Finished chunks are kept.', { projectId }, async (a) => {
    await run({ type: 'cancel', projectId: a.projectId })
    return { cancelled: true }
  })
  tool(
    'wait_for_progress',
    `Waits until a chunk finishes or the project's status changes, or for timeoutSec (at most ${MAX_WAIT_SEC}), then returns the status and progress. Returns at once when the project does not run, or when a request of this project waits for you on the client provider (clientTasks.waiting > 0: take it with get_client_task). Call it again until status is done.`,
    { projectId, timeoutSec: z.number().min(1).max(MAX_WAIT_SEC).optional().describe(`Default ${DEFAULT_WAIT_SEC}`) },
    (a) => waitForProgress(service, bus, a.projectId, Math.min(MAX_WAIT_SEC, a.timeoutSec ?? DEFAULT_WAIT_SEC)),
    true
  )

  // ---- review ----

  tool('get_chunk', 'One chunk with its source segments, translation, final text and QA issues.', { projectId, index: z.number().int().min(1).describe('Chunk number, 1-based') }, (a) => run({ type: 'getChunk', projectId: a.projectId, index: a.index }), true)
  tool(
    'edit_chunk',
    'Saves your text for segments of a chunk and marks it done. final maps segment ids (see get_chunk) to the new text. Refused while the project runs.',
    { projectId, index: z.number().int().min(1), final: z.record(z.string(), z.string()) },
    (a) => run({ type: 'editChunk', projectId: a.projectId, index: a.index, final: a.final })
  )
  tool(
    'retry_chunk',
    "Translates a chunk again with the app's models, optionally trying another translator model first. Returns at once: follow it with wait_for_progress.",
    { projectId, index: z.number().int().min(1), model: z.string().optional().describe('provider/model to try first') },
    async (a) => {
      await run({ type: 'retryChunk', projectId: a.projectId, index: a.index, model: a.model })
      return { started: true }
    }
  )
  tool(
    'update_glossary',
    'Replaces the glossary (the whole list). Chunks translated after this use the new entries.',
    {
      projectId,
      entries: z.array(z.object({ source: z.string(), target: z.string(), type: z.string().describe('person, place, org, term or phrase'), gender: z.string().optional().describe('m, f or n'), note: z.string().optional() }))
    },
    async (a) => {
      await run({ type: 'updateGlossary', projectId: a.projectId, entries: a.entries })
      return { entries: a.entries.length }
    }
  )
  tool('set_brief', 'Writes the book brief (genre, tone, register, point of view, characters) that every translation request carries.', { projectId, brief: z.string() }, async (a) => {
    await run({ type: 'setBrief', projectId: a.projectId, brief: a.brief })
    return { saved: true }
  })
  tool('export_project', 'Writes the translated document (partial progress works: untranslated blocks keep the source text). Returns the file path (a folder for a visual-novel book).', { projectId, outPath: z.string().optional().describe('Absolute output path (default: the project output folder)') }, (a) => run({ type: 'export', projectId: a.projectId, outPath: a.outPath }))

  // ---- the client provider: you answer the app's model calls ----

  tool(
    'list_client_tasks',
    'The requests the app made to the client provider (model client/claude-code) that wait for you or are leased: waiting, leased and the tasks with job, role, task, project, unit, state and age.',
    {},
    () => run({ type: 'listClientTasks' }),
    true
  )
  tool(
    'get_client_task',
    'Leases the oldest waiting request of the client provider (for 30 minutes) and returns taskId, meta, system, user, schema (when the answer is JSON), output (what to reply with) and leaseMinutes, or {none: true, waiting}. Answer it with submit_client_task. A lease that runs out puts the task back in the queue.',
    { role: z.string().optional().describe('glossary, translator, proofreader or qa'), project: z.string().optional(), task: z.string().optional().describe('For example translate, retry, retry-tags, fix, proofread, glossary, review, recheck') },
    (a) => run({ type: 'getClientTask', role: a.role, project: a.project, task: a.task })
  )
  tool(
    'submit_client_task',
    'Answers a leased request with text, as `output` of get_client_task says. A JSON answer is checked against the schema: if it fails, {accepted: false, problems} and the task stays leased, so fix it and submit again. A task that is gone (the project was paused, cancelled or the engine restarted) says so.',
    { taskId: z.string().min(1), text: z.string() },
    (a) => run({ type: 'submitClientTask', taskId: a.taskId, text: a.text })
  )
  tool('release_client_task', 'Gives a leased request back to the queue, for another client to take.', { taskId: z.string().min(1) }, (a) => run({ type: 'releaseClientTask', taskId: a.taskId }))

  // ---- translate it yourself ----

  tool(
    'prepare_chunks',
    'Splits the book into chunks without running any model. Chunks are made again only while all of them are untouched. Then use get_translation_task.',
    { projectId, maxChunkTokens: z.number().int().min(100).optional() },
    async (a) => {
      const r = (await run({ type: 'prepareChunks', projectId: a.projectId, maxChunkTokens: a.maxChunkTokens })) as { chunks: { state: string }[]; budget: number }
      return { chunks: r.chunks.length, budget: r.budget, pending: r.chunks.filter((c) => c.state === 'pending' || c.state === 'failed').length }
    }
  )
  tool(
    'get_translation_task',
    'The next chunk to translate (or the chunk at index), as the messages the app translator would get: rules, brief, glossary entries, the previous passage and the <seg id> segments. Translate them and send the answer to submit_translation.',
    { projectId, index: z.number().int().min(1).optional().describe('A specific chunk, to translate it again') },
    async (a) => {
      try {
        const t = (await run({ type: 'getTranslationTask', projectId: a.projectId, index: a.index })) as { messages: { role: string; content: string }[] }
        const { messages, ...meta } = t
        return { content: [{ type: 'text' as const, text: JSON.stringify(meta) }, ...messages.map((m) => ({ type: 'text' as const, text: `[${m.role}]\n${m.content}` }))] }
      } catch (err) {
        if (err instanceof Error && err.message === NOTHING_LEFT) return { done: true, remaining: 0, message: NOTHING_LEFT }
        throw err
      }
    },
    true
  )
  tool(
    'submit_translation',
    'Saves your translation of a chunk. Give reply (the <seg id="..">text</seg> elements) or segments (id to text). Every id exactly once and inline tags unchanged, or nothing is saved and problems says why.',
    {
      projectId,
      index: z.number().int().min(1),
      reply: z.string().optional().describe('The seg elements as text'),
      segments: z.record(z.string(), z.string()).optional().describe('Segment id to translated text'),
      model: z.string().optional().describe('Name to record for the translator (default external/mcp)')
    },
    (a) => run({ type: 'submitTranslation', projectId: a.projectId, index: a.index, reply: a.reply, segments: a.segments, model: a.model })
  )

  server.registerPrompt(
    'translate_book_yourself',
    {
      title: 'Translate a book yourself',
      description: "Step by step: you translate the book, the app chunks it, checks the segments and exports the file. The app's models are not used.",
      argsSchema: { file: z.string().describe('Absolute path of the book'), targetLanguage: z.string().describe('For example Croatian') }
    },
    (a) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Translate the book "${a.file}" into ${a.targetLanguage} with Book Translator, translating it yourself.

1. create_project with sourcePath "${a.file}", targetLanguage "${a.targetLanguage}" and enabledAgents { glossary: false, proofreader: false, qa: false }. Keep the project id.
2. prepare_chunks with that project id.
3. Optional but worth it for a long book: read the first chunks with get_translation_task, then write update_glossary (names, places, terms with their translation) and set_brief (genre, tone, register, point of view, characters).
4. Loop: get_translation_task, translate every <seg> as its messages ask (same ids, inline tags such as <1>, </1>, <2/> copied exactly, no comments), then submit_translation with the project id, the chunk index and your reply. If it is rejected, fix what problems says and submit the same chunk again. Stop when get_translation_task says nothing is left.
5. export_project and tell me the file path.`
          }
        }
      ]
    })
  )

  server.registerPrompt(
    'translate_with_full_pipeline',
    {
      title: 'Translate a book with the full pipeline, answering the app models yourself',
      description: 'The app runs glossary, translation, proofreading and QA; you answer every model call through the client provider. Nothing is spent.',
      argsSchema: { file: z.string().describe('Absolute path of the book'), targetLanguage: z.string().describe('For example Croatian') }
    },
    (a) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: `Translate the book "${a.file}" into ${a.targetLanguage} with Book Translator's full pipeline, answering its model calls yourself.

1. list_models: client/claude-code must be there and available. If it is not, tell me: the client provider has to be added to config/providers.md of the data folder (see the README).
2. create_project with sourcePath "${a.file}", targetLanguage "${a.targetLanguage}" and clientOnly true (all four agents go on client/claude-code and no other model can be used, so nothing is spent). Keep the project id.
3. start_translation with that project id.
4. Loop: wait_for_progress. While clientTasks.waiting is above 0, call get_client_task (project: the id), do what it says (meta.role and meta.task tell the job) and reply as its output says: JSON that matches the schema for glossary and QA, <seg id> segments with the same ids and inline tags (<1>, </1>, <2/>) for translation, proofreading and fixes. submit_client_task with taskId and text. If it comes back with accepted false, fix the problems and submit again. If it says the task is gone, take the next one.
5. Stop when wait_for_progress says status done (if it says paused, start_translation again). Then export_project and tell me the file path.
6. Last, update_project_settings with clientOnly false and agentModels for real models, so the project does not wait for a client again.`
          }
        }
      ]
    })
  )

  return server
}

/** Status and progress of a project from the files and the run state. */
async function snapshotOf(service: EngineService, id: string) {
  // asked first: a run that has ended has saved its last status, a run that is still going may save one while the files are read
  const running = service.isRunning(id)
  const [project, chunks] = await Promise.all([service.store.load(id), service.store.listChunks(id)])
  return { project, chunks, counts: countStates(chunks), running }
}

/** The client-provider requests of one project: waiting and leased. */
function clientCounts(service: EngineService, projectId: string): { waiting: number; leased: number } {
  const mine = service.clientQueue.list().filter((t) => t.project === projectId)
  const leased = mine.filter((t) => t.state === 'leased').length
  return { waiting: mine.length - leased, leased }
}

function describe(service: EngineService, s: Awaited<ReturnType<typeof snapshotOf>>, p: ProjectFile, errors: string[], timedOut: boolean) {
  const { counts, chunks } = s
  return {
    status: p.status,
    running: s.running,
    timedOut,
    done: counts.done + counts.flagged,
    total: chunks.length,
    counts,
    spend: p.spend,
    clientTasks: clientCounts(service, p.id),
    ...(errors.length > 0 ? { errors } : {})
  }
}

async function waitForProgress(service: EngineService, bus: EngineBus, id: string, seconds: number) {
  const first = await snapshotOf(service, id)
  if (!first.running || clientCounts(service, id).waiting > 0) return describe(service, first, first.project, [], false)
  const finished = (c: { done: number; failed: number }) => c.done + c.failed
  const baseline = finished(first.counts)
  const errors: string[] = []
  const timedOut = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => stop(true), seconds * 1000)
    // a request on the client provider has no event: look for one now and then
    const poll = setInterval(() => {
      if (clientCounts(service, id).waiting > 0) stop(false)
    }, 500)
    const stop = (late: boolean) => {
      clearTimeout(timer)
      clearInterval(poll)
      off()
      resolve(late)
    }
    const off = bus.on((ev: EngineEvent) => {
      if (ev.type === 'error' && ev.projectId === id) errors.push(ev.message)
      else if (ev.type === 'log' && ev.projectId === id && ev.level === 'error') errors.push(ev.message)
      if (ev.type === 'project.updated' && ev.project.id === id) stop(false)
      else if (ev.type === 'error' && ev.projectId === id) stop(false)
      else if (ev.type === 'progress' && ev.projectId === id) {
        const p: ProgressInfo = ev
        if (finished({ done: p.perStage.done + p.perStage.flagged, failed: p.perStage.failed }) !== baseline) stop(false)
      }
    })
  })
  const now = await snapshotOf(service, id)
  return describe(service, now, now.project, errors, timedOut)
}
