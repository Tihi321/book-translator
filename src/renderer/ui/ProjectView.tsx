import { memo, useEffect, useMemo, useState } from 'react'
import { CHUNK_STATES, IN_PROGRESS_STATES } from '../../shared/project'
import type { ChunkState } from '../../shared/project'
import type { ChunkBrief, Command, ProjectDetail } from '../../shared/protocol'
import { getApi } from '../api'
import { fmtCost, fmtCount, fmtDuration, modelName, STATE_LABEL } from '../format'
import { attempt, EMPTY_LIVE, progressOf, RUNNING_STATUSES, useStore } from '../store/store'
import { ChunkDrawer } from './ChunkDrawer'
import { GlossaryTab } from './GlossaryTab'

type Tab = 'chunks' | 'glossary' | 'log'

const Tile = memo(function Tile({ index, state, issues, selected, onOpen }: { index: number; state: ChunkState; issues: number; selected: boolean; onOpen: (i: number) => void }) {
  return <button className={`tile ${state}${issues > 0 ? ' has-issues' : ''}${selected ? ' selected' : ''}`} title={`chunk ${index}: ${STATE_LABEL[state]}${issues > 0 ? `, ${issues} issue(s)` : ''}`} onClick={() => onOpen(index)} />
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
              <Tile key={c.index} index={c.index} state={c.state} issues={c.issues} selected={selected === c.index} onOpen={onOpen} />
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

  async function doExport() {
    setExporting(true)
    const res = await attempt(getApi().request<'export'>({ type: 'export', projectId: id }))
    if (res) {
      toast(`Exported to ${res.path}`, 'info')
      await attempt(getApi().showInFolder(res.path))
    }
    setExporting(false)
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
          <button onClick={() => void doExport()} disabled={exporting} title="Writes the document with what is translated so far" data-testid="export">{exporting ? 'Exporting...' : 'Export'}</button>
          <button onClick={() => void attempt(getApi().openPath(detail.outputRel))}>Open folder</button>
        </div>
      </div>

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
        {(['chunks', 'glossary', 'log'] as const).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'chunks' ? 'Chunks' : t === 'glossary' ? `Glossary (${detail.glossary.length})` : 'Log'}
          </button>
        ))}
      </div>
      {tab === 'chunks' && (
        <div className="stack">
          <Sections detail={detail} selected={openChunk} onOpen={setOpenChunk} />
        </div>
      )}
      {tab === 'glossary' && <GlossaryTab detail={detail} />}
      {tab === 'log' && <LogTab id={id} detail={detail} />}

      {openChunk !== null && <ChunkDrawer detail={detail} index={openChunk} onClose={() => setOpenChunk(null)} />}
    </div>
  )
}
