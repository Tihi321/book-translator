import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import type { ParallelSettings, ProjectSettings } from '../../shared/project'
import type { AnalyzeResult } from '../../shared/protocol'
import { AGENTS } from '../../shared/agents'
import type { AgentName } from '../../shared/agents'
import { getApi } from '../api'
import { fmtCost, fmtCount, fmtDuration } from '../format'
import { attempt, useStore } from '../store/store'
import { ModelListEditor } from './ModelListEditor'
import { seedList } from './ModelSelect'
import { ParallelFields } from './ParallelFields'

const AGENT_LABEL: Record<AgentName, string> = { glossary: 'Glossary builder', translator: 'Translator', proofreader: 'Proofreader', qa: 'QA reviewer' }
const OTHER = '__other'
const FORMATS = 'EPUB, DOCX, TXT, Markdown or PDF'

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

/** Several documents at once (a folder, or more than one dropped file): one translation each, with the same settings. */
interface Batch {
  /** The folder, or "N dropped items". */
  label: string
  files: { path: string; on: boolean }[]
}

interface BatchEstimate {
  files: number
  chunks: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  seconds: number
  failed: string[]
}

export function NewProject() {
  const models = useStore((s) => s.models)
  const defaults = useStore((s) => s.defaults)
  const info = useStore((s) => s.info)
  const setView = useStore((s) => s.setView)
  const setModels = useStore((s) => s.setModels)
  const toast = useStore((s) => s.toast)

  const [file, setFile] = useState<string | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [batchEst, setBatchEst] = useState<BatchEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [startNow, setStartNow] = useState(true)
  const [done, setDone] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [starting, setStarting] = useState(false)

  const [target, setTarget] = useState('hr')
  const [targetOther, setTargetOther] = useState('')
  const [sourceLang, setSourceLang] = useState('')
  const [picked, setPicked] = useState<Partial<Record<AgentName, string[]>>>({})
  const [parallelEdit, setParallelEdit] = useState<ParallelSettings | null>(null)
  const [enabled, setEnabled] = useState({ glossary: true, proofreader: true, qa: true })
  const [pauseAfterGlossary, setPauseAfterGlossary] = useState(false)
  const [maxChunk, setMaxChunk] = useState<number | null>(null)

  const chunkSize = maxChunk ?? defaults?.defaultMaxChunkTokens ?? 1500
  const targetLanguage = target === OTHER ? targetOther.trim() : target
  const listFor = (a: AgentName) => picked[a] ?? seedList(models, defaults?.agentModels[a])
  const parallel: ParallelSettings = parallelEdit ?? defaults?.parallel ?? { enabled: true, maxAtOnce: 'auto', splitSections: false }

  const settings = useMemo<Partial<ProjectSettings>>(
    () => ({
      agentModels: Object.fromEntries(AGENTS.map((a) => [a, (picked[a] ?? seedList(models, defaults?.agentModels[a])).filter(Boolean)])) as Record<AgentName, string[]>,
      enabled,
      maxChunkTokens: chunkSize,
      pauseAfterGlossary,
      parallel
    }),
    [picked, models, defaults, enabled, chunkSize, pauseAfterGlossary, parallel]
  )

  // the estimate follows every change (debounced); a late answer for an older request is dropped
  const seq = useRef(0)
  useEffect(() => {
    if (!file || !targetLanguage) return
    const mine = ++seq.current
    const t = setTimeout(() => {
      setBusy(true)
      getApi()
        .request<'analyze'>({ type: 'analyze', sourcePath: file, targetLanguage, settings })
        .then((res) => {
          if (seq.current !== mine) return
          setAnalysis(res)
          setError(null)
          setSourceLang((cur) => cur || res.file.language || '')
        })
        .catch((err: Error) => {
          if (seq.current !== mine) return
          setAnalysis(null)
          setError(err.message)
        })
        .finally(() => {
          if (seq.current === mine) setBusy(false)
        })
    }, 250)
    return () => clearTimeout(t)
  }, [file, targetLanguage, settings])

  // a batch estimate is for the settings it was made with
  useEffect(() => setBatchEst(null), [settings, targetLanguage, batch])

  const supported = (p: string) => {
    const exts = info?.extensions ?? []
    const dot = p.lastIndexOf('.')
    return exts.length === 0 || (dot >= 0 && exts.includes(p.slice(dot).toLowerCase()))
  }

  function openFile(path: string) {
    setBatch(null)
    setAnalysis(null)
    setError(null)
    setSourceLang('')
    setFile(path)
  }

  /** One document opens as a single translation, more become a batch. */
  function openMany(label: string, paths: string[]) {
    const unique = [...new Set(paths)]
    if (unique.length === 0) {
      toast(`No ${FORMATS} files in ${label}`, 'error')
      return
    }
    if (unique.length === 1) return openFile(unique[0]!)
    setFile(null)
    setAnalysis(null)
    setError(null)
    setSourceLang('')
    setBatch({ label, files: unique.map((path) => ({ path, on: true })) })
  }

  async function choose() {
    const path = await attempt(getApi().pickFile())
    if (path) openFile(path)
  }

  async function chooseFolder() {
    const listing = await attempt(getApi().pickFolder())
    if (listing) openMany(listing.folder, listing.files)
  }

  // ---- drag and drop: a file, several files, or folders (their documents, top level) ----

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  function onDragOver(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dragging) setDragging(true)
  }

  function onDragLeave(e: DragEvent) {
    // leaving for a child element is not leaving the page
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setDragging(false)
  }

  async function onDrop(e: DragEvent) {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragging(false)
    const api = getApi()
    const items = [...e.dataTransfer.items]
    const dropped = [...e.dataTransfer.files].map((f, i) => ({ path: api.pathForFile(f), dir: items[i]?.webkitGetAsEntry()?.isDirectory === true }))
    const dirs = dropped.filter((d) => d.dir && d.path).map((d) => d.path)
    const docs = dropped.filter((d) => !d.dir && d.path).map((d) => d.path)
    const skipped = docs.filter((p) => !supported(p))
    if (skipped.length > 0) toast(`Not a ${FORMATS} file: ${skipped.map(baseName).join(', ')}`, 'error')
    const listed: string[] = []
    for (const dir of dirs) {
      const listing = await attempt(api.listFolder(dir))
      if (listing) listed.push(...listing.files)
    }
    const paths = [...docs.filter(supported), ...listed]
    if (dirs.length === 0 && paths.length === 0) return
    openMany(dirs.length === 1 && docs.length === 0 ? dirs[0]! : `${dropped.length} dropped items`, paths)
  }

  async function refreshLocal() {
    setRefreshing(true)
    const info = await attempt(getApi().request<'refreshModels'>({ type: 'refreshModels' }))
    if (info) {
      setModels(info)
      const failed = info.discovery.filter((d) => d.error)
      toast(failed.length ? `Local models: ${failed.map((d) => `${d.provider} ${d.error}`).join('; ')}` : `Found ${info.discovery.reduce((n, d) => n + d.found, 0)} local model(s)`, failed.length ? 'error' : 'info')
    }
    setRefreshing(false)
  }

  async function start() {
    if (!file || !targetLanguage) return
    setStarting(true)
    const project = await attempt(getApi().request<'createProject'>({ type: 'createProject', sourcePath: file, targetLanguage, sourceLanguage: sourceLang.trim() || undefined, settings }))
    if (project) {
      await attempt(getApi().request<'start'>({ type: 'start', projectId: project.id }))
      setView({ name: 'project', id: project.id })
    }
    setStarting(false)
  }

  const batchOn = batch ? batch.files.filter((x) => x.on) : []

  /** Analyzes every ticked document one after another and adds the estimates up. */
  async function estimateBatch() {
    if (!batch || !targetLanguage) return
    setEstimating(true)
    const sum: BatchEstimate = { files: 0, chunks: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, seconds: 0, failed: [] }
    for (const x of batchOn) {
      try {
        const res = await getApi().request<'analyze'>({ type: 'analyze', sourcePath: x.path, targetLanguage, settings })
        const e = res.estimate
        sum.files++
        sum.chunks += e.chunks
        sum.tokensIn += e.estTokensIn
        sum.tokensOut += e.estTokensOut
        sum.costUsd += e.estCostUsd
        sum.seconds += e.estSeconds
      } catch (err) {
        sum.failed.push(`${baseName(x.path)}: ${(err as Error).message}`)
      }
    }
    setBatchEst(sum)
    setEstimating(false)
  }

  /** One translation per ticked document, with the same settings; started now, or left in the list to start later. */
  async function startBatch() {
    if (!batch || !targetLanguage) return
    setStarting(true)
    setDone(0)
    let ok = 0
    const failed: string[] = []
    for (const x of batchOn) {
      try {
        const project = await getApi().request<'createProject'>({ type: 'createProject', sourcePath: x.path, targetLanguage, sourceLanguage: sourceLang.trim() || undefined, settings })
        if (startNow) await getApi().request<'start'>({ type: 'start', projectId: project.id })
        ok++
      } catch (err) {
        failed.push(`${baseName(x.path)}: ${(err as Error).message}`)
      }
      setDone((n) => n + 1)
    }
    setStarting(false)
    if (failed.length > 0) toast(`${failed.length} of ${batchOn.length} could not be created: ${failed.join('; ')}`, 'error')
    if (ok > 0) {
      toast(`${ok} translation(s) ${startNow ? 'started' : 'created'}`, 'info')
      setView({ name: 'list' })
    }
  }

  const f = analysis?.file
  const est = analysis?.estimate
  const noTranslator = listFor('translator').filter(Boolean).length === 0
  const hiddenCount = models ? models.models.filter((m) => !m.available).length : 0
  const budgetLimited = est && est.budget < chunkSize

  return (
    <div className="page narrow stack" onDragEnter={onDragOver} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={(e) => void onDrop(e)}>
      <div className="row spread">
        <h2>New translation</h2>
        <button onClick={() => setView({ name: 'list' })}>Back</button>
      </div>

      <div className={`card stack dropzone${dragging ? ' dragging' : ''}`} data-testid="dropzone">
        <div className="row">
          <button className="primary" onClick={() => void choose()} data-testid="choose-file">
            {file || batch ? 'Open another file' : 'Open a file'}
          </button>
          <button onClick={() => void chooseFolder()} data-testid="choose-folder">Open a folder</button>
          <span className="mono dim grow" title={file ?? batch?.label ?? ''}>{dragging ? 'Drop to open' : (file ?? batch?.label ?? `${FORMATS}, or drop files or a folder here`)}</span>
        </div>
        {error && <div className="bad" data-testid="analyze-error">{error}</div>}
        {batch && (
          <div className="stack" data-testid="batch">
            <div className="row spread">
              <span>{batchOn.length} of {batch.files.length} documents, one translation each with the settings below</span>
              <div className="row">
                <button onClick={() => setBatch({ ...batch, files: batch.files.map((x) => ({ ...x, on: true })) })}>All</button>
                <button onClick={() => setBatch({ ...batch, files: batch.files.map((x) => ({ ...x, on: false })) })}>None</button>
              </div>
            </div>
            <div className="batch-list">
              {batch.files.map((x, i) => (
                <label key={x.path} className="row small" title={x.path}>
                  <input type="checkbox" checked={x.on} onChange={(e) => setBatch({ ...batch, files: batch.files.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)) })} />
                  <span className="mono">{baseName(x.path)}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {f && (
          <div className="stats">
            <div className="stat"><b>{f.format.toUpperCase()}</b><span>format</span></div>
            <div className="stat"><b title={f.title}>{f.title ? (f.title.length > 22 ? f.title.slice(0, 21) + '...' : f.title) : '(none)'}</b><span>title</span></div>
            <div className="stat"><b>{fmtCount(f.blocks)}</b><span>blocks in {f.sections} section(s)</span></div>
            <div className="stat"><b>{fmtCount(f.words)}</b><span>words</span></div>
            <div className="stat"><b>{fmtCount(f.tokens)}</b><span>tokens</span></div>
          </div>
        )}
        {f?.format === 'pdf' && <div className="note">PDF: the text is extracted, the page layout is not preserved. The translation is written as an EPUB (and Markdown). Scanned PDFs without a text layer are not supported.</div>}
      </div>

      {(file || batch) && (
        <>
          <div className="card form">
            <label>Source language</label>
            <input list="lang-names" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} placeholder={batch ? 'detected from each document, or type it for all' : 'detected from the document, or type it'} data-testid="source-lang" />
            <label>Target language</label>
            <div className="row">
              <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="target-lang">
                {(defaults?.languages ?? []).map((l) => (
                  <option key={l.code} value={l.code}>{l.name}</option>
                ))}
                <option value={OTHER}>Other...</option>
              </select>
              {target === OTHER && <input value={targetOther} onChange={(e) => setTargetOther(e.target.value)} placeholder="language name, for example Latin" />}
            </div>
            <datalist id="lang-names">
              {(defaults?.languages ?? []).map((l) => (
                <option key={l.code} value={l.name} />
              ))}
            </datalist>
          </div>

          <div className="card stack">
            <div className="row spread">
              <h3>Agents and models</h3>
              <button onClick={() => void refreshLocal()} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh local models'}</button>
            </div>
            <div className="form">
              {AGENTS.map((a) => (
                <Row key={a} agent={a} enabled={a === 'translator' ? true : enabled[a]} onEnabled={(v) => setEnabled((e) => ({ ...e, [a]: v }))}>
                  <ModelListEditor value={listFor(a)} onChange={(list) => setPicked((p) => ({ ...p, [a]: list }))} disabled={a !== 'translator' && !enabled[a]} testId={`model-${a}`} />
                </Row>
              ))}
              <span />
              <label className="row small">
                <input type="checkbox" checked={pauseAfterGlossary} disabled={!enabled.glossary} onChange={(e) => setPauseAfterGlossary(e.target.checked)} />
                Pause after the glossary, so I can review it
              </label>
              <ParallelFields value={parallel} onChange={setParallelEdit} testId="new-parallel" />
              <label>Chunk size</label>
              <div className="row">
                <input type="range" min={300} max={6000} step={100} value={chunkSize} onChange={(e) => setMaxChunk(Number(e.target.value))} className="grow" />
                <span style={{ minWidth: 90 }}>{chunkSize} tokens</span>
              </div>
            </div>
            {hiddenCount > 0 && <div className="dim small">{hiddenCount} model(s) are hidden because their provider has no API key or is switched off. See Settings.</div>}
            {models && models.models.some((m) => m.local) === false && <div className="dim small">No local models found. Start LM Studio (load the model with a context of 32k or more) or Strata, then press Refresh.</div>}
            {est && budgetLimited && <div className="dim small">Chunks are limited to {est.budget} tokens by the smallest context window of the selected models.</div>}
          </div>

          {batch ? (
            <div className="card stack" data-testid="batch-estimate">
              <div className="row spread">
                <h3>Estimate</h3>
                <button onClick={() => void estimateBatch()} disabled={estimating || batchOn.length === 0 || !targetLanguage}>{estimating ? 'Estimating...' : `Estimate ${batchOn.length} document(s)`}</button>
              </div>
              {batchEst ? (
                <>
                  <div className="stats">
                    <div className="stat"><b>{batchEst.files}</b><span>documents</span></div>
                    <div className="stat"><b>{fmtCount(batchEst.chunks)}</b><span>chunks</span></div>
                    <div className="stat"><b>{fmtCount(batchEst.tokensIn)} / {fmtCount(batchEst.tokensOut)}</b><span>tokens in / out</span></div>
                    <div className="stat"><b>{batchEst.costUsd > 0 ? fmtCost(batchEst.costUsd) : 'free'}</b><span>cost</span></div>
                    <div className="stat"><b>~{fmtDuration(batchEst.seconds)}</b><span>time, one after another (rough)</span></div>
                  </div>
                  {batchEst.failed.length > 0 && <div className="bad small">{batchEst.failed.join('; ')}</div>}
                </>
              ) : (
                <span className="dim small">Reads every ticked document, so it can take a while for a big folder.</span>
              )}
            </div>
          ) : (
            <div className="card stack" data-testid="estimate">
              <h3>Estimate {busy && <span className="dim">(updating...)</span>}</h3>
              {est ? (
                <>
                  <div className="stats">
                    <div className="stat"><b data-testid="est-chunks">{est.chunks}</b><span>chunks (up to {est.budget} tokens)</span></div>
                    <div className="stat"><b>{fmtCount(est.estTokensIn)} / {fmtCount(est.estTokensOut)}</b><span>tokens in / out</span></div>
                    <div className="stat"><b>{est.estCostUsd > 0 ? fmtCost(est.estCostUsd) : 'free'}</b><span>cost</span></div>
                    <div className="stat"><b>~{fmtDuration(est.estSeconds)}</b><span>time (rough)</span></div>
                  </div>
                  <div className="dim small">
                    {AGENTS.filter((a) => est.perAgent[a]).map((a) => `${AGENT_LABEL[a]}: ${fmtCost(est.perAgent[a]!.costUsd)}, ~${fmtDuration(est.perAgent[a]!.seconds)}`).join('  |  ')}
                  </div>
                </>
              ) : (
                <span className="dim">{error ? 'No estimate.' : 'Calculating...'}</span>
              )}
            </div>
          )}

          <div className="row">
            {batch ? (
              <>
                <button className="primary" disabled={starting || batchOn.length === 0 || noTranslator || !targetLanguage} onClick={() => void startBatch()} data-testid="start-batch">
                  {starting ? `Creating ${done + 1} of ${batchOn.length}...` : `${startNow ? 'Start' : 'Create'} ${batchOn.length} translation(s)`}
                </button>
                <label className="row small" title="All start at once; the provider limits decide how many requests run together">
                  <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
                  Start them now (otherwise start them from the list)
                </label>
              </>
            ) : (
              <button className="primary" disabled={starting || !est || noTranslator || !targetLanguage} onClick={() => void start()} data-testid="start">
                {starting ? 'Starting...' : 'Start translation'}
              </button>
            )}
            {noTranslator && <span className="warn">No model is available. Start LM Studio or Strata, or add an API key in Settings.</span>}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ agent, enabled, onEnabled, children }: { agent: AgentName; enabled: boolean; onEnabled: (v: boolean) => void; children: ReactNode }) {
  return (
    <>
      <label className="row" style={{ color: 'var(--text)', alignSelf: 'start', paddingTop: 4 }}>
        {agent === 'translator' ? <input type="checkbox" checked disabled /> : <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} data-testid={`enable-${agent}`} />}
        {AGENT_LABEL[agent]}
      </label>
      {children}
    </>
  )
}
