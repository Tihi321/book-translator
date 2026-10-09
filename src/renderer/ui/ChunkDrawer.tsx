import { useEffect, useRef, useState } from 'react'
import type { ChunkRecord } from '../../shared/project'
import type { ProjectDetail } from '../../shared/protocol'
import { getApi } from '../api'
import { fmtCost, modelName, STATE_LABEL } from '../format'
import { useStore } from '../store/store'
import { ModelSelect } from './ModelSelect'

/** One chunk: source and translation side by side per segment, QA issues, and the actions edit / accept / retranslate. */
export function ChunkDrawer({ detail, index, onClose }: { detail: ProjectDetail; index: number; onClose: () => void }) {
  const models = useStore((s) => s.models)
  const toast = useStore((s) => s.toast)
  const id = detail.project.id
  const brief = detail.chunks.find((c) => c.index === index)
  const [chunk, setChunk] = useState<ChunkRecord | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [retryModel, setRetryModel] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = Object.keys(edits).length > 0
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const running = detail.running

  // loads the chunk, and again when its state changes (unless there are unsaved edits)
  useEffect(() => {
    if (dirtyRef.current && chunk?.index === index) return
    let alive = true
    getApi()
      .request<'getChunk'>({ type: 'getChunk', projectId: id, index })
      .then((c) => {
        if (alive) setChunk(c)
      })
      .catch((err: Error) => toast(err.message))
    return () => {
      alive = false
    }
  }, [id, index, brief?.state, brief?.issues])

  useEffect(() => {
    setEdits({})
    setChunk(null)
  }, [index])

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok, 'info')
    } catch (err) {
      toast((err as Error).message)
    }
    setBusy(false)
  }

  const save = (final: Record<string, string>) =>
    act(async () => {
      const c = await getApi().request<'editChunk'>({ type: 'editChunk', projectId: id, index, final })
      setChunk(c)
      setEdits({})
    }, 'Chunk marked done')

  const text = (segId: string) => edits[segId] ?? chunk?.final[segId] ?? chunk?.translation[segId] ?? ''
  const issuesFor = (segId: string) => chunk?.qa.issues.filter((i) => i.segId === segId) ?? []
  const known = new Set(chunk?.segments.map((s) => s.id))
  const loose = chunk?.qa.issues.filter((i) => !known.has(i.segId)) ?? []

  return (
    <>
      <div className="drawer-back" onClick={onClose} />
      <div className="drawer" data-testid="chunk-drawer">
        <header className="stack" style={{ gap: 6 }}>
          <div className="row spread">
            <div className="row">
              <h2>Chunk {index}</h2>
              {brief && <span className={`badge ${brief.state}`}>{STATE_LABEL[brief.state]}</span>}
              {chunk?.edited && <span className="badge">edited</span>}
              {chunk && <span className="dim small">{modelName(chunk.model)} &middot; {chunk.tokens.in}/{chunk.tokens.out} tok &middot; {fmtCost(chunk.costUsd)} &middot; {(chunk.ms / 1000).toFixed(1)}s</span>}
            </div>
            <button onClick={onClose}>Close</button>
          </div>
          {chunk?.error && <div className="bad">{chunk.error}</div>}
          {running && <div className="warn small">The translation is running. Pause it to edit or retranslate chunks.</div>}
        </header>
        <div className="body">
          {!chunk && <div className="dim">Loading...</div>}
          {loose.map((i, k) => (
            <div key={k} className={`issue ${i.severity}`}>{i.segId}: {i.type} ({i.severity}) {i.comment}</div>
          ))}
          {chunk?.segments.map((seg) => (
            <div key={seg.id} className="seg">
              <div className="src">
                <div className="dim small mono">{seg.id}</div>
                {seg.text}
              </div>
              <div>
                <textarea
                  value={text(seg.id)}
                  rows={Math.min(14, Math.max(2, Math.ceil(text(seg.id).length / 60)))}
                  onChange={(e) => setEdits((x) => ({ ...x, [seg.id]: e.target.value }))}
                  disabled={running}
                />
              </div>
              {issuesFor(seg.id).length > 0 && (
                <div className="issues">
                  {issuesFor(seg.id).map((i, k) => (
                    <div key={k} className={`issue ${i.severity}`}>
                      <b>{i.type}</b> ({i.severity}): {i.comment}
                      {i.suggestion && <div className="dim">Suggestion: {i.suggestion}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <footer className="row spread">
          <div className="row">
            <button className="primary" disabled={!dirty || busy || running} onClick={() => void save(edits)} data-testid="save-edits">Save edits</button>
            <button disabled={busy || running || !chunk} onClick={() => void save({})} title="Keep the text as it is and mark the chunk done (accepts the QA flags)">Accept flags</button>
          </div>
          <div className="row">
            <span className="dim small">Retranslate with</span>
            <ModelSelect models={models} value={retryModel} onChange={setRetryModel} emptyLabel="the project's translator" disabled={running} />
            <button
              disabled={busy || running}
              onClick={() =>
                void act(async () => {
                  await getApi().request<'retryChunk'>({ type: 'retryChunk', projectId: id, index, model: retryModel || undefined })
                  setEdits({})
                })
              }
              data-testid="retranslate"
            >
              Retranslate
            </button>
          </div>
        </footer>
      </div>
    </>
  )
}
