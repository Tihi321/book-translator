import { create } from 'zustand'
import type { ChunkBrief, EngineEvent, EngineInfo, ModelsInfo, ProgressInfo, ProjectDetail } from '../../shared/protocol'
import { CHUNK_STATES } from '../../shared/project'
import type { ChunkState, ProjectSummary } from '../../shared/project'
import type { DefaultsConfig } from '../../shared/schemas'
import { getApi } from '../api'

export type View = { name: 'list' } | { name: 'new' } | { name: 'project'; id: string } | { name: 'settings' }

export interface Toast {
  id: number
  kind: 'error' | 'info'
  text: string
}

export interface LogLine {
  level: 'info' | 'warn' | 'error'
  message: string
}

/** What the open run reports live. Chunk texts are never kept here, only the tail of the stream of the chunks being worked on. */
export interface Live {
  progress?: ProgressInfo
  /** For the throughput: when the run's first progress arrived, the output tokens then, and when the latest arrived. */
  startedAt?: number
  startOut?: number
  lastAt?: number
  stream: Record<number, { stage: ChunkState; text: string }>
  logs: LogLine[]
}

const STREAM_TAIL = 3000
const STREAM_CHUNKS = 3
const LOG_LIMIT = 300
/** Statuses of a project that is working now. */
export const RUNNING_STATUSES = ['glossary', 'translating']

export const emptyLive = (): Live => ({ stream: {}, logs: [] })
/** For selectors: a constant, because a selector that returns a new object every time makes React loop. */
export const EMPTY_LIVE: Live = Object.freeze({ stream: {}, logs: [] }) as Live

export interface State {
  view: View
  info: EngineInfo | null
  projects: ProjectSummary[]
  models: ModelsInfo | null
  defaults: DefaultsConfig | null
  detail: ProjectDetail | null
  live: Record<string, Live>
  toasts: Toast[]
  /** Open chunk (drawer) of the open project. */
  openChunk: number | null

  setView(view: View): void
  setOpenChunk(index: number | null): void
  setModels(models: ModelsInfo): void
  setDefaults(defaults: DefaultsConfig): void
  loadDetail(id: string): Promise<void>
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
  applyEvents(events: EngineEvent[], now?: number): void
  init(): Promise<void>
}

let toastId = 1

function patchLive(live: Record<string, Live>, id: string, fn: (l: Live) => Live): Record<string, Live> {
  return { ...live, [id]: fn(live[id] ?? emptyLive()) }
}

export const useStore = create<State>()((set, get) => ({
  view: { name: 'list' },
  info: null,
  projects: [],
  models: null,
  defaults: null,
  detail: null,
  live: {},
  toasts: [],
  openChunk: null,

  setView(view) {
    set({ view, openChunk: null, ...(view.name === 'project' ? {} : { detail: null }) })
    if (view.name === 'project') void get().loadDetail(view.id)
  },

  setOpenChunk(index) {
    set({ openChunk: index })
  },

  setModels(models) {
    set({ models })
  },

  setDefaults(defaults) {
    set({ defaults })
  },

  async loadDetail(id) {
    try {
      const detail = await getApi().request<'getProject'>({ type: 'getProject', projectId: id })
      const v = get().view
      if (v.name !== 'project' || v.id !== id) return
      // the log file is now up to date, so the live log lines start over
      set((s) => ({ detail, live: patchLive(s.live, id, (l) => ({ ...l, logs: [] })) }))
    } catch (err) {
      get().toast(`Could not open the project: ${(err as Error).message}`)
      if (get().view.name === 'project') set({ view: { name: 'list' }, detail: null })
    }
  },

  toast(text, kind = 'error') {
    const id = toastId++
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 12000 : 4000)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  applyEvents(events, now = Date.now()) {
    if (events.length === 0) return
    const s = get()
    let { projects, live, detail, models, view } = s
    let chunks: ChunkBrief[] | undefined
    let detailChanged = false
    let reload: string | null = null
    const toasts: string[] = []

    const openId = () => (detail ? detail.project.id : null)
    const ownChunks = (): ChunkBrief[] => {
      if (!chunks) chunks = [...detail!.chunks]
      return chunks
    }

    for (const ev of events) {
      switch (ev.type) {
        case 'snapshot':
          projects = ev.projects
          break
        case 'models':
          models = ev.models
          break
        case 'project.updated': {
          const i = projects.findIndex((p) => p.id === ev.project.id)
          projects = i < 0 ? [ev.project, ...projects] : projects.map((p, k) => (k === i ? ev.project : p))
          const running = RUNNING_STATUSES.includes(ev.project.status)
          if (!running) live = patchLive(live, ev.project.id, (l) => ({ ...l, progress: undefined, startedAt: undefined, startOut: undefined, lastAt: undefined, stream: {} }))
          if (openId() === ev.project.id && detail) {
            if (detail.project.status !== ev.project.status) reload = ev.project.id
            detail = { ...detail, running, project: { ...detail.project, status: ev.project.status, spend: ev.project.spend, settings: detail.project.settings } }
            detailChanged = true
          }
          break
        }
        case 'project.deleted':
          projects = projects.filter((p) => p.id !== ev.projectId)
          if (view.name === 'project' && view.id === ev.projectId) {
            view = { name: 'list' }
            detail = null
            chunks = undefined
          }
          break
        case 'chunk.state':
          if (openId() === ev.projectId && detail) {
            const list = ownChunks()
            const at = list[ev.index - 1]?.index === ev.index ? ev.index - 1 : list.findIndex((c) => c.index === ev.index)
            const cur = list[at]
            if (cur) {
              list[at] = { ...cur, state: ev.state, model: ev.model ?? cur.model, tokensIn: ev.tokens?.in ?? cur.tokensIn, tokensOut: ev.tokens?.out ?? cur.tokensOut, issues: ev.issues ?? cur.issues }
              detailChanged = true
            }
          }
          break
        case 'chunk.token':
          // only the open project shows a stream
          if (openId() === ev.projectId) {
            live = patchLive(live, ev.projectId, (l) => {
              const prev = l.stream[ev.index]
              const text = ((prev && prev.stage === ev.stage ? prev.text : '') + ev.text).slice(-STREAM_TAIL)
              const keep = Object.keys(l.stream).map(Number).filter((k) => k !== ev.index).slice(-(STREAM_CHUNKS - 1))
              const stream: Live['stream'] = {}
              for (const k of keep) stream[k] = l.stream[k]!
              stream[ev.index] = { stage: ev.stage, text }
              return { ...l, stream }
            })
          }
          break
        case 'progress':
          live = patchLive(live, ev.projectId, (l) => {
            const { type: _type, projectId: _id, ...info } = ev
            return { ...l, progress: info, startedAt: l.startedAt ?? now, startOut: l.startOut ?? ev.tokensOut, lastAt: now }
          })
          break
        case 'log':
          if (ev.projectId) live = patchLive(live, ev.projectId, (l) => ({ ...l, logs: [...l.logs, { level: ev.level, message: ev.message }].slice(-LOG_LIMIT) }))
          break
        case 'error':
          toasts.push(ev.message)
          if (ev.projectId) live = patchLive(live, ev.projectId, (l) => ({ ...l, logs: [...l.logs, { level: 'error' as const, message: ev.message }].slice(-LOG_LIMIT) }))
          break
        default:
          break
      }
    }

    if (detailChanged && detail) detail = { ...detail, chunks: chunks ?? detail.chunks }
    set({ projects, live, detail, models, view })
    for (const t of toasts) get().toast(t)
    if (reload) void get().loadDetail(reload)
  },

  async init() {
    const api = getApi()
    const [info, models, defaults] = await Promise.all([api.request<'getInfo'>({ type: 'getInfo' }), api.request<'listModels'>({ type: 'listModels' }), api.request<'getDefaults'>({ type: 'getDefaults' })])
    set({ info, models, defaults })
    await api.request<'snapshot'>({ type: 'snapshot' })
  }
}))

/** The progress to show: the live one while a run reports, else computed from the chunks and the saved spend. */
export function progressOf(detail: ProjectDetail, live: Live | undefined): ProgressInfo {
  if (live?.progress) return live.progress
  const perStage = Object.fromEntries(CHUNK_STATES.map((st) => [st, 0])) as Record<ChunkState, number>
  for (const c of detail.chunks) perStage[c.state]++
  const sp = detail.project.spend
  return { done: perStage.done + perStage.flagged, total: detail.chunks.length, perStage, tokensIn: sp.tokensIn, tokensOut: sp.tokensOut, costUsd: sp.costUsd, etaSec: null }
}

/**
 * Connects the store to the engine: events are queued and applied every 100 ms, so a burst of streamed tokens
 * and chunk updates causes one render, not hundreds. Returns a function that disconnects.
 */
export function connectEngine(intervalMs = 100): () => void {
  const api = getApi()
  let queue: EngineEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    const batch = queue
    queue = []
    useStore.getState().applyEvents(batch)
  }
  const off = api.on((event) => {
    queue.push(event)
    if (!timer) timer = setTimeout(flush, intervalMs)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    queue = []
  }
}

/** Runs an engine request and shows its error as a toast. Resolves to undefined on failure. */
export async function attempt<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p
  } catch (err) {
    useStore.getState().toast((err as Error).message)
    return undefined
  }
}
