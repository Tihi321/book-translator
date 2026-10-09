import { useEffect, useState } from 'react'
import type { GlossaryEntry } from '../../shared/project'
import type { ProjectDetail } from '../../shared/protocol'
import { getApi } from '../api'
import { useStore } from '../store/store'

const TYPES = ['person', 'place', 'org', 'term', 'phrase']

/** Editable glossary table plus the book brief. Saved entries apply to the chunks that start after the save. */
export function GlossaryTab({ detail }: { detail: ProjectDetail }) {
  const toast = useStore((s) => s.toast)
  const id = detail.project.id
  const [rows, setRows] = useState<GlossaryEntry[]>(detail.glossary)
  const [dirty, setDirty] = useState(false)

  // a rebuilt glossary replaces the table, unless the user has unsaved edits
  useEffect(() => {
    if (!dirty) setRows(detail.glossary)
  }, [detail.glossary, dirty])

  const edit = (i: number, patch: Partial<GlossaryEntry>) => {
    setRows((r) => r.map((row, k) => (k === i ? { ...row, ...patch } : row)))
    setDirty(true)
  }

  async function save() {
    const clean = rows.filter((r) => r.source.trim() && r.target.trim()).map((r) => ({ ...r, source: r.source.trim(), target: r.target.trim() }))
    try {
      await getApi().request<'updateGlossary'>({ type: 'updateGlossary', projectId: id, entries: clean })
    } catch (err) {
      toast((err as Error).message)
      return
    }
    setRows(clean)
    setDirty(false)
    toast(`Glossary saved (${clean.length} entries). It applies to the chunks that start from now on.`, 'info')
  }

  return (
    <div className="stack">
      <details open={detail.brief.length > 0}>
        <summary>Book brief (brief.md)</summary>
        <pre className="logbox mono" style={{ maxHeight: 200 }}>{detail.brief || 'No brief yet. The glossary builder writes it.'}</pre>
      </details>
      <div className="row">
        <button onClick={() => { setRows((r) => [...r, { source: '', target: '', type: 'term' }]); setDirty(true) }}>Add entry</button>
        <button className="primary" disabled={!dirty} onClick={() => void save()} data-testid="save-glossary">Save glossary</button>
        <button disabled={!dirty} onClick={() => { setRows(detail.glossary); setDirty(false) }}>Revert</button>
        <span className="dim small">{dirty ? 'Unsaved changes.' : 'Edits apply to the chunks that start after you save.'}</span>
      </div>
      <table className="plain">
        <thead>
          <tr>
            <th style={{ width: '24%' }}>Source</th>
            <th style={{ width: '24%' }}>Target</th>
            <th style={{ width: 90 }}>Type</th>
            <th style={{ width: 60 }}>Gender</th>
            <th>Note</th>
            <th style={{ width: 30 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input value={r.source} onChange={(e) => edit(i, { source: e.target.value })} /></td>
              <td><input value={r.target} onChange={(e) => edit(i, { target: e.target.value })} /></td>
              <td>
                <select value={TYPES.includes(r.type) ? r.type : 'term'} onChange={(e) => edit(i, { type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                <select value={r.gender ?? ''} onChange={(e) => edit(i, { gender: e.target.value || undefined })}>
                  <option value="" />
                  <option>m</option>
                  <option>f</option>
                  <option>n</option>
                </select>
              </td>
              <td><input value={r.note ?? ''} onChange={(e) => edit(i, { note: e.target.value || undefined })} /></td>
              <td><button title="Remove" onClick={() => { setRows((x) => x.filter((_, k) => k !== i)); setDirty(true) }}>x</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="dim">The glossary is empty. The glossary builder fills it when the translation starts, or add entries by hand.</div>}
    </div>
  )
}
