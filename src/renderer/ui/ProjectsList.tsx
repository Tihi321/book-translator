import { useState } from 'react'
import type { ProjectSummary } from '../../shared/project'
import { getApi } from '../api'
import { fmtCost, fmtCount } from '../format'
import { attempt, EMPTY_LIVE, useStore } from '../store/store'

function ProjectCard({ p }: { p: ProjectSummary }) {
  const setView = useStore((s) => s.setView)
  const live = useStore((s) => s.live[p.id] ?? EMPTY_LIVE)
  const [confirm, setConfirm] = useState(false)
  const total = live.progress?.total ?? p.chunks
  const done = live.progress?.done ?? p.done
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="card project-card" onClick={() => setView({ name: 'project', id: p.id })} data-testid="project-card">
      <div className="row spread">
        <span className="title" title={p.name}>{p.name}</span>
        <span className={`badge ${p.status}`}>{p.status}</span>
      </div>
      <div className="dim small">
        {p.sourceLanguage ?? '?'} &rarr; {p.targetLanguage} &middot; {p.format.toUpperCase()}
      </div>
      <div className="bar" title={`${done} of ${total} chunks`}>
        <span className="seg-done" style={{ width: `${pct}%` }} />
      </div>
      <div className="row spread small dim">
        <span>
          {total > 0 ? `${done}/${total} chunks (${pct}%)` : 'not started'}
          {p.flagged > 0 && <span className="warn"> &middot; {p.flagged} flagged</span>}
          {p.failed > 0 && <span className="bad"> &middot; {p.failed} failed</span>}
        </span>
        <span>
          {fmtCost(p.spend.costUsd)} &middot; {fmtCount(p.spend.tokensIn + p.spend.tokensOut)} tok
        </span>
      </div>
      <div className="row" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setView({ name: 'project', id: p.id })}>Open</button>
        {confirm ? (
          <>
            <span className="small">Delete this project and its files?</span>
            <button className="danger" onClick={() => void attempt(getApi().request<'deleteProject'>({ type: 'deleteProject', projectId: p.id }))}>
              Delete
            </button>
            <button onClick={() => setConfirm(false)}>Keep</button>
          </>
        ) : (
          <button onClick={() => setConfirm(true)}>Delete</button>
        )}
      </div>
    </div>
  )
}

export function ProjectsList() {
  const projects = useStore((s) => s.projects)
  const setView = useStore((s) => s.setView)
  return (
    <div className="page narrow">
      <div className="row spread" style={{ marginBottom: 14 }}>
        <h2>Translations</h2>
        <button className="primary" onClick={() => setView({ name: 'new' })} data-testid="new-translation">
          New translation
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="empty">
          <p>No translations yet.</p>
          <button className="primary" onClick={() => setView({ name: 'new' })}>
            Translate a book or document
          </button>
        </div>
      ) : (
        <div className="cards">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  )
}
