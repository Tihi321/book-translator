import { useEffect, useState } from 'react'
import type { BookFile } from '../../../shared/protocol'
import { getApi } from '../../api'
import { attempt, useStore } from '../../store/store'
import type { ReaderSource } from '../../store/store'
import { EpubViewer } from './EpubViewer'
import { PdfViewer } from './PdfViewer'
import { loadPos, savePos, THEMES } from './position'
import type { Theme } from './position'
import { TextViewer } from './TextViewer'

const keyOf = (s: ReaderSource) => ('path' in s ? s.path : `${s.projectId}:${s.side}`)
const toTarget = (s: ReaderSource) => ('path' in s ? { path: s.path } : { projectId: s.projectId })

function initialTheme(): Theme {
  const t = loadPos('prefs.theme')
  return t === 'light' || t === 'sepia' || t === 'dark' ? t : 'light'
}

export function Reader({ source }: { source?: ReaderSource }) {
  const setView = useStore((s) => s.setView)
  // a file picked in the reader replaces the source it was opened with
  const [picked, setPicked] = useState<ReaderSource | null>(null)
  const current = picked ?? source
  const [file, setFile] = useState<BookFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fontSize, setFontSize] = useState(() => Number(loadPos('prefs.font')) || 18)
  const [theme, setTheme] = useState<Theme>(initialTheme)

  const cur = current ? keyOf(current) : null
  useEffect(() => {
    if (!current) return
    let dead = false
    setFile(null)
    setError('')
    setLoading(true)
    getApi()
      .readBook(toTarget(current))
      .then((f) => !dead && setFile(f))
      .catch((err: Error) => !dead && setError(err.message))
      .finally(() => !dead && setLoading(false))
    return () => {
      dead = true
    }
  }, [cur])

  async function open() {
    const p = await attempt(getApi().pickBook())
    if (p) setPicked({ path: p })
  }
  const size = (d: number) => {
    const n = Math.min(40, Math.max(10, fontSize + d))
    setFontSize(n)
    savePos('prefs.font', String(n))
  }
  const pick = (t: Theme) => {
    setTheme(t)
    savePos('prefs.theme', t)
  }
  const projectId = !picked && source ? source.projectId : undefined
  const t = THEMES[theme]

  return (
    <div className="reader">
      <div className="row reader-bar">
        <button onClick={() => void open()}>Open file</button>
        {projectId && <button onClick={() => setView({ name: 'project', id: projectId })}>Back to project</button>}
        <span className="grow reader-name" title={file?.name}>{file?.name ?? ''}</span>
        {file && file.ext !== '.pdf' && (
          <>
            <button onClick={() => size(-2)} title="Smaller text">A-</button>
            <button onClick={() => size(2)} title="Larger text">A+</button>
          </>
        )}
        {file && (['light', 'sepia', 'dark'] as const).map((x) => (
          <button key={x} className={theme === x ? 'active' : ''} onClick={() => pick(x)}>{x}</button>
        ))}
      </div>
      <div className="reader-body">
        {!current && (
          <div className="reader-empty stack">
            <div className="dim">Open an EPUB, PDF, TXT or Markdown file to read it here.</div>
            <div><button className="primary" onClick={() => void open()}>Open file</button></div>
          </div>
        )}
        {loading && <div className="dim" style={{ padding: 16 }}>Loading...</div>}
        {error && <div className="warn" style={{ padding: 16 }}>{error}</div>}
        {file && current && file.ext === '.epub' && <EpubViewer file={file} posKey={keyOf(current)} fontSize={fontSize} theme={theme} />}
        {file && current && file.ext === '.pdf' && <PdfViewer file={file} posKey={keyOf(current)} theme={theme} />}
        {file && current && file.ext !== '.epub' && file.ext !== '.pdf' && (
          <div className="reader-themed" style={{ background: t.bg, color: t.fg }}>
            <TextViewer file={file} posKey={keyOf(current)} fontSize={fontSize} />
          </div>
        )}
      </div>
    </div>
  )
}
