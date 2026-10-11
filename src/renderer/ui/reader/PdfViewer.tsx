import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import type { BookFile } from '../../../shared/protocol'
import { loadPos, savePos, THEMES } from './position'
import type { Theme } from './position'

GlobalWorkerOptions.workerSrc = workerUrl

const GAP = 12

function PageCanvas({ doc, num, scale, w, h, root }: { doc: PDFDocumentProxy; num: number; scale: number; w: number; h: number; root: React.RefObject<HTMLDivElement | null> }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { root: root.current, rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [root])

  useEffect(() => {
    const c = canvas.current
    if (!visible || !c) return
    let task: RenderTask | null = null
    let dead = false
    void doc.getPage(num).then((page) => {
      if (dead) return
      const vp = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      c.width = Math.floor(vp.width * ratio)
      c.height = Math.floor(vp.height * ratio)
      c.style.width = `${Math.floor(vp.width)}px`
      c.style.height = `${Math.floor(vp.height)}px`
      const ctx = c.getContext('2d')
      if (!ctx) return
      task = page.render({ canvas: c, canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
      task.promise.catch(() => undefined)
    })
    return () => {
      dead = true
      task?.cancel()
    }
  }, [visible, doc, num, scale])

  return (
    <div ref={wrap} className="pdf-page" style={{ width: w, height: h, marginBottom: GAP }}>
      {visible && <canvas ref={canvas} />}
    </div>
  )
}

export function PdfViewer({ file, posKey, theme }: { file: BookFile; posKey: string; theme: Theme }) {
  const box = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [base, setBase] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [jump, setJump] = useState('1')
  const [error, setError] = useState('')
  const restored = useRef(false)

  useEffect(() => {
    let dead = false
    restored.current = false
    setDoc(null)
    setError('')
    const task = getDocument({ data: file.bytes.slice() })
    task.promise
      .then(async (d) => {
        if (dead) return void d.destroy()
        const p1 = await d.getPage(1)
        const vp = p1.getViewport({ scale: 1 })
        if (dead) return void d.destroy()
        setBase({ w: vp.width, h: vp.height })
        setDoc(d)
      })
      .catch((err: Error) => !dead && setError(err.message))
    return () => {
      dead = true
      void task.destroy()
    }
  }, [file])

  const scale = zoom * (fit ?? 1)
  const pageH = base ? Math.floor(base.h * scale) + GAP : 0

  // fit-width of the first page is the starting zoom
  useEffect(() => {
    if (base && box.current && fit === null) setFit(Math.max(0.3, (box.current.clientWidth - 40) / base.w))
  }, [base, fit])

  const goto = (n: number) => {
    if (!doc || !box.current) return
    const c = Math.min(doc.numPages, Math.max(1, n))
    box.current.scrollTo({ top: (c - 1) * pageH })
  }

  // restore the remembered page once sizes are known
  useEffect(() => {
    if (!doc || fit === null || restored.current) return
    restored.current = true
    const n = Number(loadPos(posKey))
    if (n > 1) goto(n)
  })

  function onScroll() {
    if (!doc || !box.current || pageH === 0) return
    const n = Math.min(doc.numPages, Math.floor(box.current.scrollTop / pageH) + 1)
    if (n !== page) {
      setPage(n)
      setJump(String(n))
    }
    savePos(posKey, String(n))
  }

  const fitWidth = () => {
    if (base && box.current) {
      setFit(Math.max(0.3, (box.current.clientWidth - 40) / base.w))
      setZoom(1)
    }
  }
  const z = (f: number) => setZoom((v) => Math.min(4, Math.max(0.3, v * f)))

  return (
    <div className="reader-pdf">
      <div className="row reader-nav">
        <button onClick={() => z(1 / 1.2)} title="Zoom out">&minus;</button>
        <span className="dim small">{Math.round(scale * 100)}%</span>
        <button onClick={() => z(1.2)} title="Zoom in">+</button>
        <button onClick={fitWidth}>Fit width</button>
        <span className="dim">Page</span>
        <input
          className="reader-jump"
          value={jump}
          onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && goto(Number(jump) || 1)}
        />
        <span className="dim">/ {doc?.numPages ?? '-'}</span>
        {error && <span className="warn">{error}</span>}
      </div>
      <div className="reader-scroll" style={{ background: theme === 'light' ? '#cfd4dc' : THEMES[theme].bg }} ref={box} onScroll={onScroll}>
        {doc && base && fit !== null && (
          <div className="pdf-pages">
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PageCanvas key={i + 1} doc={doc} num={i + 1} scale={scale} w={Math.floor(base.w * scale)} h={Math.floor(base.h * scale)} root={box} />
            ))}
          </div>
        )}
        {!doc && !error && <div className="dim" style={{ padding: 16 }}>Loading...</div>}
      </div>
    </div>
  )
}
