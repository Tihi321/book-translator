import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useMemo, useRef } from 'react'
import type { BookFile } from '../../../shared/protocol'
import { loadPos, savePos } from './position'

export function TextViewer({ file, posKey, fontSize }: { file: BookFile; posKey: string; fontSize: number }) {
  const box = useRef<HTMLDivElement>(null)
  const isMd = file.ext === '.md' || file.ext === '.markdown'
  const text = useMemo(() => new TextDecoder('utf-8').decode(file.bytes), [file])
  const html = useMemo(() => (isMd ? DOMPurify.sanitize(marked.parse(text, { async: false })) : ''), [isMd, text])

  // restore the scroll ratio once the text is in
  useEffect(() => {
    const el = box.current
    if (!el) return
    const r = Number(loadPos(posKey))
    if (r > 0) el.scrollTop = r * (el.scrollHeight - el.clientHeight)
  }, [posKey, html, text])

  function onScroll() {
    const el = box.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    savePos(posKey, String(max > 0 ? el.scrollTop / max : 0))
  }

  // links must not navigate the app window; in-page anchors still scroll
  function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) box.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView()
  }

  return (
    <div className="reader-scroll" ref={box} onScroll={onScroll} onClick={onClick}>
      {isMd ? (
        <div className="reader-text md" style={{ fontSize }} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="reader-text txt" style={{ fontSize }}>{text}</div>
      )}
    </div>
  )
}
