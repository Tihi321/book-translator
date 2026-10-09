import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from '../src/renderer/api'
import { emptyLive, progressOf, useStore } from '../src/renderer/store/store'
import type { BookTranslatorApi, ChunkBrief, EngineEvent, ProjectDetail } from '../src/shared/protocol'
import type { ChunkState, ProjectFile, ProjectSummary } from '../src/shared/project'

const summary = (id: string, status: ProjectSummary['status'] = 'translating'): ProjectSummary => ({
  id,
  name: id,
  sourcePath: `/x/${id}.md`,
  format: 'md',
  targetLanguage: 'Croatian',
  status,
  createdAt: '',
  updatedAt: '',
  chunks: 3,
  done: 0,
  flagged: 0,
  failed: 0,
  spend: { tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0 }
})

const brief = (index: number, state: ChunkState = 'pending'): ChunkBrief => ({ index, sectionId: 's1', state, issues: 0, majorIssues: 0, tokensIn: 0, tokensOut: 0 })

function detailOf(id: string, chunks: ChunkBrief[]): ProjectDetail {
  const project = { id, status: 'translating', spend: { tokensIn: 5, tokensOut: 7, costUsd: 0.5, ms: 0 }, settings: { targetLanguage: 'Croatian' } } as unknown as ProjectFile
  return { project, chunks, sections: [{ id: 's1', title: 'One' }], glossary: [], brief: '', log: '', running: true, outputRel: `projects/${id}/output` }
}

describe('renderer store', () => {
  let requests: unknown[]
  beforeEach(() => {
    requests = []
    const api: BookTranslatorApi = {
      on: () => () => undefined,
      request: (async (command: { type: string; projectId?: string }) => {
        requests.push(command)
        if (command.type === 'getProject') return detailOf(command.projectId!, [brief(1, 'done'), brief(2), brief(3)])
        return undefined
      }) as unknown as BookTranslatorApi['request'],
      pickFile: async () => null,
      openPath: async () => true,
      showInFolder: async () => true
    }
    setApi(api)
    useStore.setState({ view: { name: 'list' }, projects: [], detail: null, live: {}, toasts: [], openChunk: null })
  })

  it('keeps the projects list from snapshot and project events', () => {
    const s = useStore.getState()
    s.applyEvents([{ type: 'snapshot', projects: [summary('a', 'created')] }, { type: 'project.updated', project: summary('b') }, { type: 'project.updated', project: summary('a', 'done') }])
    expect(useStore.getState().projects.map((p) => `${p.id}:${p.status}`)).toEqual(['b:translating', 'a:done'])
    s.applyEvents([{ type: 'project.deleted', projectId: 'b' }])
    expect(useStore.getState().projects.map((p) => p.id)).toEqual(['a'])
  })

  it('applies a batch of chunk events and progress to the open project in one update', () => {
    useStore.setState({ view: { name: 'project', id: 'p' }, detail: detailOf('p', [brief(1), brief(2), brief(3)]) })
    const events: EngineEvent[] = [
      { type: 'chunk.state', projectId: 'p', index: 1, state: 'translating', model: 'mock/m' },
      { type: 'chunk.state', projectId: 'p', index: 1, state: 'done', model: 'mock/m', tokens: { in: 10, out: 12 }, issues: 0 },
      { type: 'chunk.state', projectId: 'p', index: 2, state: 'flagged', issues: 2 },
      { type: 'chunk.state', projectId: 'other', index: 3, state: 'failed' },
      { type: 'chunk.token', projectId: 'p', index: 3, stage: 'translating', text: 'ab' },
      { type: 'chunk.token', projectId: 'p', index: 3, stage: 'translating', text: 'cd' },
      { type: 'progress', projectId: 'p', done: 2, total: 3, perStage: { pending: 1, translating: 0, proofreading: 0, reviewing: 0, fixing: 0, done: 1, flagged: 1, failed: 0 }, tokensIn: 100, tokensOut: 50, costUsd: 0.01, etaSec: 30 }
    ]
    useStore.getState().applyEvents(events, 1000)
    const s = useStore.getState()
    expect(s.detail!.chunks.map((c) => c.state)).toEqual(['done', 'flagged', 'pending'])
    expect(s.detail!.chunks[0]).toMatchObject({ model: 'mock/m', tokensIn: 10, tokensOut: 12 })
    expect(s.detail!.chunks[1]!.issues).toBe(2)
    expect(s.live.p!.stream[3]).toEqual({ stage: 'translating', text: 'abcd' })
    expect(progressOf(s.detail!, s.live.p)).toMatchObject({ done: 2, etaSec: 30, tokensOut: 50 })
    // tokens of a project that is not open are not kept
    useStore.getState().applyEvents([{ type: 'chunk.token', projectId: 'zzz', index: 1, stage: 'translating', text: 'x' }])
    expect(useStore.getState().live.zzz).toBeUndefined()
  })

  it('computes progress from the chunks when no run reports, and reloads the detail when the status changes', async () => {
    useStore.getState().setView({ name: 'project', id: 'p' })
    await new Promise((r) => setTimeout(r, 10))
    const d = useStore.getState().detail!
    expect(progressOf(d, emptyLive())).toMatchObject({ done: 1, total: 3, tokensIn: 5, tokensOut: 7, costUsd: 0.5, etaSec: null })
    requests.length = 0
    useStore.getState().applyEvents([{ type: 'project.updated', project: summary('p', 'paused') }])
    expect(useStore.getState().detail!.running).toBe(false)
    expect(requests).toContainEqual({ type: 'getProject', projectId: 'p' })
  })

  it('shows engine errors as toasts and in the project log', () => {
    useStore.getState().applyEvents([{ type: 'error', projectId: 'p', message: 'boom' }])
    expect(useStore.getState().toasts.map((t) => t.text)).toEqual(['boom'])
    expect(useStore.getState().live.p!.logs).toEqual([{ level: 'error', message: 'boom' }])
  })
})
