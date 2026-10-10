import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProjectSettings } from '../../shared/project'
import type { AnalyzeResult } from '../../shared/protocol'
import { AGENTS } from '../../shared/agents'
import type { AgentName } from '../../shared/agents'
import { getApi } from '../api'
import { fmtCost, fmtCount, fmtDuration } from '../format'
import { attempt, useStore } from '../store/store'
import { ModelSelect, pickDefault } from './ModelSelect'

const AGENT_LABEL: Record<AgentName, string> = { glossary: 'Glossary builder', translator: 'Translator', proofreader: 'Proofreader', qa: 'QA reviewer' }
const OTHER = '__other'

export function NewProject() {
  const models = useStore((s) => s.models)
  const defaults = useStore((s) => s.defaults)
  const setView = useStore((s) => s.setView)
  const setModels = useStore((s) => s.setModels)
  const toast = useStore((s) => s.toast)

  const [file, setFile] = useState<string | null>(null)
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [starting, setStarting] = useState(false)

  const [target, setTarget] = useState('hr')
  const [targetOther, setTargetOther] = useState('')
  const [sourceLang, setSourceLang] = useState('')
  const [picked, setPicked] = useState<Partial<Record<AgentName, string>>>({})
  const [enabled, setEnabled] = useState({ glossary: true, proofreader: true, qa: true })
  const [pauseAfterGlossary, setPauseAfterGlossary] = useState(false)
  const [maxChunk, setMaxChunk] = useState<number | null>(null)

  const chunkSize = maxChunk ?? defaults?.defaultMaxChunkTokens ?? 1500
  const targetLanguage = target === OTHER ? targetOther.trim() : target
  const modelFor = (a: AgentName) => picked[a] ?? pickDefault(models, defaults?.agentModels[a])

  const settings = useMemo<Partial<ProjectSettings>>(
    () => ({
      agentModels: Object.fromEntries(AGENTS.map((a) => [a, [picked[a] ?? pickDefault(models, defaults?.agentModels[a])].filter(Boolean)])) as Record<AgentName, string[]>,
      enabled,
      maxChunkTokens: chunkSize,
      pauseAfterGlossary
    }),
    [picked, models, defaults, enabled, chunkSize, pauseAfterGlossary]
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

  async function choose() {
    const path = await attempt(getApi().pickFile())
    if (!path) return
    setAnalysis(null)
    setSourceLang('')
    setFile(path)
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

  const f = analysis?.file
  const est = analysis?.estimate
  const noTranslator = !modelFor('translator')
  const hiddenCount = models ? models.models.filter((m) => !m.available).length : 0
  const budgetLimited = est && est.budget < chunkSize

  return (
    <div className="page narrow stack">
      <div className="row spread">
        <h2>New translation</h2>
        <button onClick={() => setView({ name: 'list' })}>Back</button>
      </div>

      <div className="card stack">
        <div className="row">
          <button className="primary" onClick={() => void choose()} data-testid="choose-file">
            {file ? 'Choose another file' : 'Open a file'}
          </button>
          <span className="mono dim grow" title={file ?? ''}>{file ?? 'EPUB, DOCX, TXT, Markdown or PDF'}</span>
        </div>
        {error && <div className="bad" data-testid="analyze-error">{error}</div>}
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

      {file && (
        <>
          <div className="card form">
            <label>Source language</label>
            <input list="lang-names" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} placeholder="detected from the document, or type it" data-testid="source-lang" />
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
                  <ModelSelect models={models} value={modelFor(a)} onChange={(ref) => setPicked((p) => ({ ...p, [a]: ref }))} disabled={a !== 'translator' && !enabled[a]} testId={`model-${a}`} />
                </Row>
              ))}
              <span />
              <label className="row small">
                <input type="checkbox" checked={pauseAfterGlossary} disabled={!enabled.glossary} onChange={(e) => setPauseAfterGlossary(e.target.checked)} />
                Pause after the glossary, so I can review it
              </label>
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

          <div className="row">
            <button className="primary" disabled={starting || !est || noTranslator || !targetLanguage} onClick={() => void start()} data-testid="start">
              {starting ? 'Starting...' : 'Start translation'}
            </button>
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
      <label className="row" style={{ color: 'var(--text)' }}>
        {agent === 'translator' ? <input type="checkbox" checked disabled /> : <input type="checkbox" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} data-testid={`enable-${agent}`} />}
        {AGENT_LABEL[agent]}
      </label>
      {children}
    </>
  )
}
