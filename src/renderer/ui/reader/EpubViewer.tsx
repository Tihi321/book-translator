import ePub from 'epubjs'
import type { NavItem, Rendition } from 'epubjs'
import { useEffect, useRef, useState } from 'react'
import type { BookFile } from '../../../shared/protocol'
import { loadPos, savePos, THEMES } from './position'
import type { Theme } from './position'

export function EpubViewer({ file, posKey, fontSize, theme }: { file: BookFile; posKey: string; fontSize: number; theme: Theme }) {
  const host = useRef<HTMLDivElement>(null)
  const rendition = useRef<Rendition | null>(null)
  const [toc, setToc] = useState<NavItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    const el = host.current
    if (!el) return
    setError('')
    // a copy, because the buffer may be larger than the view
    const book = ePub(file.bytes.slice().buffer as ArrayBuffer)
    const r = book.renderTo(el, { flow: 'paginated', width: '100%', height: '100%', allowScriptedContent: false })
    rendition.current = r
    r.on('relocated', (loc: { start: { cfi: string } }) => savePos(posKey, loc.start.cfi))
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') void r.prev()
      else if (e.key === 'ArrowRight') void r.next()
    }
    r.on('keyup', key)
    window.addEventListener('keyup', key)
    book.loaded.navigation.then((nav) => setToc(nav.toc)).catch(() => undefined)
    r.display(loadPos(posKey) ?? undefined).catch((err: Error) => setError(err.message))
    return () => {
      window.removeEventListener('keyup', key)
      rendition.current = null
      try {
        book.destroy()
      } catch {
        // already gone
      }
    }
  }, [file, posKey])

  useEffect(() => {
    const r = rendition.current
    if (!r) return
    r.themes.fontSize(`${fontSize}px`)
    r.themes.override('color', THEMES[theme].fg)
    r.themes.override('background', THEMES[theme].bg)
  }, [fontSize, theme, file, posKey])

  return (
    <div className="reader-epub">
      <div className="row reader-nav">
        <button onClick={() => void rendition.current?.prev()} title="Previous page (left arrow)">&lsaquo; Prev</button>
        <button onClick={() => void rendition.current?.next()} title="Next page (right arrow)">Next &rsaquo;</button>
        <select value="" onChange={(e) => e.target.value && void rendition.current?.display(e.target.value)}>
          <option value="">Contents...</option>
          {toc.map((t, i) => (
            <option key={i} value={t.href}>{t.label.trim()}</option>
          ))}
        </select>
        {error && <span className="warn">{error}</span>}
      </div>
      <div className="reader-epub-host" style={{ background: THEMES[theme].bg }} ref={host} />
    </div>
  )
}
