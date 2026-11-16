import { memo, useEffect, useMemo, useState } from 'react'
import { CHUNK_STATES, IN_PROGRESS_STATES } from '../../shared/project'
import type { ChunkState } from '../../shared/project'
import { exportRefusal, SOURCE_CHANGED } from '../../shared/protocol'
import type { ChunkBrief, Command, ProjectDetail } from '../../shared/protocol'
import { getApi } from '../api'
import { fmtCost, fmtCount, fmtDuration, modelName, STATE_LABEL } from '../format'
import { attempt, EMPTY_LIVE, progressOf, RUNNING_STATUSES, useStore } from '../store/store'
import { ChunkDrawer } from './ChunkDrawer'
import { GlossaryTab } from './GlossaryTab'
import { ProjectSettingsTab } from './ProjectSettingsTab'

type Tab = 'chunks' | 'glossary' | 'settings' | 'log'

const Tile = memo(function Tile({ index, state, issues, qaScore, selected, onOpen }: { index: number; state: ChunkState; issues: number; qaScore?: number; selected: boolean; onOpen: (i: number) => void }) {
  return <button className={`tile ${state}${issues > 0 ? ' has-issues' : ''}${selected ? ' selected' : ''}`} title={`chunk ${index}: ${STATE_LABEL[state]}${issues > 0 ? `, ${issues} issue(s)` : ''}${qaScore !== undefined ? `, QA ${qaScore}` : ''}`} onClick={() => onOpen(index)} />
})

function Sections({ detail, selected, onOpen }: { detail: ProjectDetail; selected: number | null; onOpen: (i: number) => void }) {
  const rows = useMemo(() => {
    const titles = new Map(detail.sections.map((s) => [s.id, s.title]))
    const order: string[] = []
    const by = new Map<string, ChunkBrief[]>()
    for (const c of detail.chunks) {
      if (!by.has(c.sectionId)) {
        by.set(c.sectionId, [])
        order.push(c.sectionId)
      }
      by.get(c.sectionId)!.push(c)
    }
    return order.map((id) => ({ id, title: titles.get(id) || id, chunks: by.get(id)! }))
  }, [detail.chunks, detail.sections])
  if (rows.length === 0) return <div className="dim">No chunks yet. They are made when the translation starts.</div>
  return (
    <div className="sections">
      {rows.map((r) => (
        <div key={r.id} className="section-row">
          <div className="label" title={`${r.title} (${r.chunks.length} chunks)`}>
            {r.title} <span className="dim">({r.chunks.length})</span>
          </div>
          <div className="tiles">
            {r.chunks.map((c) => (
              <Tile key={c.index} index={c.index} state={c.state} issues={c.issues} qaScore={c.qaScore} selected={selected === c.index} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Activity({ detail }: { detail: ProjectDetail }) {
  const working = detail.chunks.filter((c) => IN_PROGRESS_STATES.includes(c.state))
  const status = detail.project.status
  if (working.length === 0) {
    if (status === 'glossary') return <div>Building the glossary and the book brief...</div>
    if (status === 'glossary-review') return <div className="warn">Glossary ready. Review it in the Glossary tab, then press Continue.</div>
    return <div className="dim">{RUNNING_STATUSES.includes(status) ? 'Starting...' : 'Idle.'}</div>
  }
  const titles = new Map(detail.sections.map((s) => [s.id, s.title]))
  return (
    <div className="stack" style={{ gap: 2 }}>
      {working.slice(0, 4).map((c) => {
        const inSection = detail.chunks.filter((x) => x.sectionId === c.sectionId)
        const pos = inSection.findIndex((x) => x.index === c.index) + 1
        return (
          <div key={c.index}>
            Now {STATE_LABEL[c.state]}: {titles.get(c.sectionId) || c.sectionId}, chunk {pos}/{inSection.length}
            {c.model && <span className="dim"> with {modelName(c.model)}</span>}
          </div>
        )
      })}
      {working.length > 4 && <div className="dim">and {working.length - 4} more</div>}
    </div>
  )
}

function Stream({ id }: { id: string }) {
  const stream = useStore((s) => s.live[id]?.stream)
  const entries = Object.entries(stream ?? {})
  return (
    <details>
      <summary>Live model output</summary>
      {entries.length === 0 ? (
        <div className="dim small" style={{ padding: 6 }}>Nothing streaming right now.</div>
      ) : (
        entries.map(([index, s]) => (
          <div key={index}>
            <div className="dim small">chunk {index}, {s.stage}</div>
            <div className="stream mono">{s.text}</div>
          </div>
        ))
      )}
    </details>
  )
}

function LogTab({ id, detail }: { id: string; detail: ProjectDetail }) {
  const logs = useStore((s) => s.live[id]?.logs ?? EMPTY_LIVE.logs)
  const text = [detail.log.trim(), ...logs.map((l) => `- ${l.level}: ${l.message}`)].filter(Boolean).join('\n')
  return <pre className="logbox mono" data-testid="log">{text || 'The log is empty.'}</pre>
}

export function ProjectView({ id }: { id: string }) {
  const detail = useStore((s) => s.detail)
  const live = useStore((s) => s.live[id])
  const openChunk = useStore((s) => s.openChunk)
  const setOpenChunk = useStore((s) => s.setOpenChunk)
  const setView = useStore((s) => s.setView)
  const toast = useStore((s) => s.toast)
  const loadDetail = useStore((s) => s.loadDetail)
  const [tab, setTab] = useState<Tab>('chunks')
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [exporting, setExporting] = useState(false)
  // the engine refuses an export while a block is untranslated: its message is shown with "Export anyway"
  const [refused, setRefused] = useState<{ message: string; action: 'open' | 'read' } | null>(null)
  // "Refresh source": re-read the edited source file into this project
  const [refreshing, setRefreshing] = useState<'closed' | 'open' | 'busy'>('closed')

  // a quiet refresh now and then while a run is on keeps flagged counts and issue marks current
  const running = detail?.project.id === id && RUNNING_STATUSES.includes(detail.project.status)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void loadDetail(id), 15000)
    return () => clearInterval(t)
  }, [running, id, loadDetail])

  if (!detail || detail.project.id !== id) return <div className="page dim">Loading...</div>
  const p = detail.project
  const prog = progressOf(detail, live)
  const pct = (n: number) => (prog.total > 0 ? `${(n / prog.total) * 100}%` : '0%')
  const active = IN_PROGRESS_STATES.reduce((n, st) => n + prog.perStage[st], 0)
  const tps = live?.startedAt && live.lastAt && live.lastAt - live.startedAt > 2000 ? ((prog.tokensOut - (live.startOut ?? 0)) / ((live.lastAt - live.startedAt) / 1000)).toFixed(1) : null
  const send = (command: Command) => attempt(getApi().request(command as never))
  const canStart = !running && p.status !== 'done'

  /** Re-reads the source (the project's own file, or another one the user picked) and keeps the translations of unchanged paragraphs. */
  async function refreshFrom(pick: boolean) {
    const sourcePath = pick ? await attempt(getApi().pickFile()) : undefined
    if (pick && !sourcePath) return
    setRefreshing('busy')
    const res = await attempt(getApi().request<'refreshSource'>({ type: 'refreshSource', projectId: id, ...(sourcePath ? { sourcePath } : {}) }))
    setRefreshing('closed')
    if (!res) return
    toast(res.unchanged ? 'The source has not changed' : `Source refreshed: ${res.blocks.kept} paragraphs kept, ${res.blocks.toTranslate} to translate, ${res.blocks.removed} removed`, 'info')
    await loadDetail(id)
  }

  /** Exports, then shows the folder (`open`) or opens the reader (`read`). A refusal for untranslated blocks is asked about, not toasted. */
  async function exportFor(action: 'open' | 'read', allowPartial = false) {
    setExporting(true)
    setRefused(null)
    try {
      const res = await getApi().request<'export'>({ type: 'export', projectId: id, allowPartial })
      for (const w of res.warnings ?? []) toast(`Export warning: ${w}`)
      if (action === 'read') setView({ name: 'reader', source: { path: res.path, projectId: id } })
      else {
        toast(`Exported to ${res.path}`, 'info')
        await attempt(getApi().showInFolder(res.path))
      }
    } catch (err) {
      const message = (err as Error).message
      const refusal = exportRefusal(message)
      // a changed source cannot be exported past: "Export anyway" is not offered, refreshing is the way on
      if (refusal !== null && refusal.startsWith(SOURCE_CHANGED)) toast(refusal)
      else if (refusal !== null) setRefused({ message: refusal, action })
      else toast(message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="page stack">
      <div className="row spread">
        <div className="row">
          <button onClick={() => setView({ name: 'list' })}>Back</button>
          <h2 data-testid="project-title">{p.name}</h2>
          <span className={`badge ${p.status}`} data-testid="project-status">{p.status}</span>
          <span className="dim">{p.settings.sourceLanguage ?? '?'} &rarr; {p.settings.targetLanguage}</span>
        </div>
        <div className="row">
          {running ? (
            <>
              <button onClick={() => void send({ type: 'pause', projectId: id })} data-testid="pause">Pause</button>
              {confirmCancel ? (
                <>
                  <button className="danger" onClick={() => { setConfirmCancel(false); void send({ type: 'cancel', projectId: id }) }}>Cancel the run</button>
                  <button onClick={() => setConfirmCancel(false)}>Keep going</button>
                </>
              ) : (
                <button onClick={() => setConfirmCancel(true)}>Cancel</button>
              )}
            </>
          ) : (
            <button className="primary" disabled={!canStart} onClick={() => void send({ type: 'start', projectId: id })} data-testid="resume">
              {p.status === 'created' ? 'Start' : p.status === 'glossary-review' ? 'Continue' : 'Resume'}
            </button>
          )}
          {p.format !== 'docx' && p.format !== 'vn' && p.format !== 'vnp' && (
            <>
              <button onClick={() => setView({ name: 'reader', source: { projectId: id, side: 'source' } })} data-testid="read-original">Read original</button>
              <button onClick={() => void exportFor('read')} disabled={exporting} title="Exports the document, then opens it; asks first when something is untranslated" data-testid="read-translation">Read translation</button>
            </>
          )}
          <button onClick={() => void exportFor('open')} disabled={exporting} title="Writes the document; asks first when something is untranslated" data-testid="export">{exporting ? 'Exporting...' : 'Export'}</button>
          <button onClick={() => void attempt(getApi().openPath(detail.outputRel))}>Open folder</button>
          {p.format !== 'vn' && p.format !== 'vnp' && (
            <button onClick={() => setRefreshing(refreshing === 'closed' ? 'open' : 'closed')} disabled={running || refreshing === 'busy'} title="Re-read the source file after it was edited" data-testid="refresh-source">Refresh source</button>
          )}
        </div>
      </div>

      {refreshing !== 'closed' && (
        <div className="row" data-testid="refresh-row">
          <span className="small">Re-read the source and keep the translations of unchanged paragraphs (hand edits too). Changed and new paragraphs are translated by the next run.</span>
          <button className="primary" onClick={() => void refreshFrom(false)} disabled={refreshing === 'busy'} data-testid="refresh-same">Refresh from {p.sourcePath.split(/[\\/]/).pop()}</button>
          <button onClick={() => void refreshFrom(true)} disabled={refreshing === 'busy'} data-testid="refresh-pick">Choose another file...</button>
          <button onClick={() => setRefreshing('closed')} disabled={refreshing === 'busy'}>Cancel</button>
        </div>
      )}

      {refused && (
        <div className="row" data-testid="export-refused">
          <span className="small">{refused.message}</span>
          <button className="danger" onClick={() => void exportFor(refused.action, true)} disabled={exporting} data-testid="export-anyway">Export anyway</button>
          <button onClick={() => setRefused(null)} data-testid="export-cancel">Cancel</button>
        </div>
      )}

      <div className="card stack">
        <div className="bar big" title={`${prog.done} of ${prog.total} chunks`}>
          <span className="seg-done" style={{ width: pct(prog.perStage.done) }} />
          <span className="seg-flagged" style={{ width: pct(prog.perStage.flagged) }} />
          <span className="seg-failed" style={{ width: pct(prog.perStage.failed) }} />
          <span className="seg-active" style={{ width: pct(active) }} />
        </div>
        <div className="statline">
          <span><b data-testid="done-count">{prog.done}</b>/{prog.total} chunks</span>
          <span>tokens <b>{fmtCount(prog.tokensIn)}</b> in / <b>{fmtCount(prog.tokensOut)}</b> out</span>
          <span>cost <b>{fmtCost(prog.costUsd)}</b></span>
          {detail.qa.scored > 0 && (
            <span title={`scored ${detail.qa.scored} of ${prog.total} chunks by ${detail.qa.models.join(', ') || 'unknown model'}${detail.qa.independent ? '' : ' (self-reviewed)'}`}>
              QA <b data-testid="qa-score">{detail.qa.score}</b>/10
            </span>
          )}
          <span>ETA <b>{prog.etaSec === null ? (running ? 'calculating' : '-') : fmtDuration(prog.etaSec)}</b></span>
          {tps && <span>speed <b>{tps}</b> tok/s</span>}
        </div>
        <div className="stages">
          {CHUNK_STATES.map((st) => (
            <span key={st} className="stage-chip" title={st}>
              <span className={`sw ${st}`} />
              {STATE_LABEL[st]} <b style={{ color: 'var(--text)' }}>{prog.perStage[st]}</b>
            </span>
          ))}
        </div>
        <Activity detail={detail} />
        <Stream id={id} />
      </div>

      <div className="tabs">
        {(['chunks', 'glossary', 'settings', 'log'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'chunks' ? 'Chunks' : t === 'glossary' ? `Glossary (${detail.glossary.length})` : t === 'settings' ? 'Settings' : 'Log'}
          </button>
        ))}
      </div>
      {tab === 'chunks' && (
        <div className="stack">
          <Sections detail={detail} selected={openChunk} onOpen={setOpenChunk} />
        </div>
      )}
      {tab === 'glossary' && <GlossaryTab detail={detail} />}
      {tab === 'settings' && <ProjectSettingsTab detail={detail} />}
      {tab === 'log' && <LogTab id={id} detail={detail} />}

      {openChunk !== null && <ChunkDrawer detail={detail} index={openChunk} onClose={() => setOpenChunk(null)} />}
    </div>
  )
}
