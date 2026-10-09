import { useEffect, useState } from 'react'
import type { ProviderSummary } from '../../shared/protocol'
import { AGENTS } from '../../shared/agents'
import type { AgentName } from '../../shared/agents'
import { getApi } from '../api'
import { attempt, useStore } from '../store/store'
import { ModelSelect, pickDefault } from './ModelSelect'

const AGENT_LABEL: Record<AgentName, string> = { glossary: 'Glossary builder', translator: 'Translator', proofreader: 'Proofreader', qa: 'QA reviewer' }

interface Edit {
  enabled?: boolean
  baseUrl?: string
  concurrency?: number
}

function ProviderRow({ p, edit, onEdit }: { p: ProviderSummary; edit: Edit | undefined; onEdit: (e: Edit) => void }) {
  const setModels = useStore((s) => s.setModels)
  const toast = useStore((s) => s.toast)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const enabled = edit?.enabled ?? p.enabled

  async function saveKey() {
    if (!p.apiKeyEnv || !key.trim()) return
    setSaving(true)
    const info = await attempt(getApi().request<'setSecret'>({ type: 'setSecret', name: p.apiKeyEnv, value: key }))
    if (info) {
      setModels(info)
      setKey('')
      toast(`Key for ${p.id} saved in the Windows credential store`, 'info')
    }
    setSaving(false)
  }

  return (
    <tr data-testid={`provider-${p.id}`}>
      <td><input type="checkbox" checked={enabled} onChange={(e) => onEdit({ ...edit, enabled: e.target.checked })} title="Enabled" /></td>
      <td>
        <b>{p.id}</b>
        <div className="dim small">{p.local ? 'local' : 'API'} &middot; {p.kind}</div>
      </td>
      <td><input value={edit?.baseUrl ?? p.baseUrl ?? ''} onChange={(e) => onEdit({ ...edit, baseUrl: e.target.value })} /></td>
      <td><input type="number" min={1} max={64} style={{ width: 60 }} value={edit?.concurrency ?? p.concurrency} onChange={(e) => onEdit({ ...edit, concurrency: Number(e.target.value) })} /></td>
      <td>
        {p.apiKeyEnv ? (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className={p.hasKey ? 'good' : 'dim'} style={{ minWidth: 62 }}>{p.hasKey ? 'key set' : 'no key'}</span>
            <input type="password" autoComplete="off" placeholder={p.hasKey ? 'replace key' : p.apiKeyEnv} value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 150 }} data-testid={`key-${p.id}`} />
            <button disabled={!key.trim() || saving} onClick={() => void saveKey()}>Save key</button>
          </div>
        ) : (
          <span className="dim">no key needed</span>
        )}
      </td>
      <td className="small">{!p.available ? <span className={enabled ? 'warn' : 'dim'}>{p.apiKeyEnv && !p.hasKey && p.enabled ? 'needs an API key' : (p.unavailableReason ?? 'unavailable')}</span> : <span className="good">ready</span>}</td>
    </tr>
  )
}

export function Settings() {
  const models = useStore((s) => s.models)
  const defaults = useStore((s) => s.defaults)
  const setModels = useStore((s) => s.setModels)
  const setDefaults = useStore((s) => s.setDefaults)
  const toast = useStore((s) => s.toast)
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [agentPick, setAgentPick] = useState<Partial<Record<AgentName, string>>>({})
  const [chunk, setChunk] = useState<number | null>(null)

  useEffect(() => {
    void attempt(getApi().request<'listModels'>({ type: 'listModels' }).then(setModels))
  }, [setModels])

  const changed = Object.keys(edits).length > 0

  async function saveProviders() {
    const patches = Object.entries(edits).map(([id, e]) => ({ id, ...e }))
    const info = await attempt(getApi().request<'saveProviders'>({ type: 'saveProviders', providers: patches }))
    if (info) {
      setModels(info)
      setEdits({})
      toast('Providers saved to config/providers.md', 'info')
    }
  }

  async function refresh() {
    setRefreshing(true)
    const info = await attempt(getApi().request<'refreshModels'>({ type: 'refreshModels' }))
    if (info) setModels(info)
    setRefreshing(false)
  }

  async function saveDefaults() {
    const agentModels: Partial<Record<AgentName, string[]>> = {}
    for (const a of AGENTS) {
      const ref = agentPick[a]
      if (ref) agentModels[a] = [ref, ...(defaults?.agentModels[a] ?? []).filter((r) => r !== ref)]
    }
    const next = await attempt(getApi().request<'setDefaults'>({ type: 'setDefaults', patch: { agentModels, defaultMaxChunkTokens: chunk ?? undefined } }))
    if (next) {
      setDefaults(next)
      setAgentPick({})
      setChunk(null)
      toast('Defaults saved', 'info')
    }
  }

  return (
    <div className="page narrow stack">
      <h2>Settings</h2>

      <div className="card stack">
        <div className="row spread">
          <h3>Providers</h3>
          <div className="row">
            <button onClick={() => void refresh()} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh local models'}</button>
            <button className="primary" disabled={!changed} onClick={() => void saveProviders()} data-testid="save-providers">Save providers</button>
          </div>
        </div>
        <table className="plain">
          <thead>
            <tr>
              <th style={{ width: 30 }} />
              <th style={{ width: 130 }}>Provider</th>
              <th>Base URL</th>
              <th style={{ width: 80 }}>Parallel</th>
              <th style={{ width: 360 }}>API key</th>
              <th style={{ width: 150 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {(models?.providers ?? []).map((p) => (
              <ProviderRow key={p.id} p={p} edit={edits[p.id]} onEdit={(e) => setEdits((x) => ({ ...x, [p.id]: e }))} />
            ))}
          </tbody>
        </table>
        <div className="dim small">
          Keys are stored in the Windows credential store (service "book-translator") and never shown again. An environment variable with the same name takes priority. Parallel is how many requests (and chapters) run at once.
        </div>
        {(models?.discovery ?? []).map((d) => (
          <div key={d.provider} className="small">
            <b>{d.provider}</b>: {d.error ? <span className="warn">not reachable ({d.error})</span> : `${d.found} model(s) found`}
          </div>
        ))}
        <div className="dim small">Local models (LM Studio): load the model with a context of 32k or more, then press Refresh local models.</div>
      </div>

      <div className="card stack">
        <div className="row spread">
          <h3>Default models for a new translation</h3>
          <button className="primary" disabled={Object.keys(agentPick).length === 0 && chunk === null} onClick={() => void saveDefaults()}>Save defaults</button>
        </div>
        <div className="form">
          {AGENTS.map((a) => (
            <div key={a} style={{ display: 'contents' }}>
              <label>{AGENT_LABEL[a]}</label>
              <ModelSelect models={models} value={agentPick[a] ?? pickDefault(models, defaults?.agentModels[a])} onChange={(ref) => setAgentPick((x) => ({ ...x, [a]: ref }))} />
            </div>
          ))}
          <label>Chunk size (tokens)</label>
          <input type="number" min={200} max={20000} step={100} style={{ width: 100 }} value={chunk ?? defaults?.defaultMaxChunkTokens ?? 1500} onChange={(e) => setChunk(Number(e.target.value))} />
        </div>
      </div>

      <div className="card stack">
        <h3>Files</h3>
        <div className="row">
          <button onClick={() => void attempt(getApi().openPath(''))}>Open data folder</button>
          <button onClick={() => void attempt(getApi().openPath('prompts'))}>Open prompts folder</button>
          <button onClick={() => void attempt(getApi().openPath('config'))}>Open config folder</button>
        </div>
        <div className="dim small">The prompts of the agents are plain Markdown files with {'{{variables}}'}. Edit them there, changes apply to the next chunk.</div>
      </div>
    </div>
  )
}
