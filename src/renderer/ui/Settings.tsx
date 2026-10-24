import { useEffect, useState } from 'react'
import type { ParallelSettings } from '../../shared/project'
import type { McpStatus, ProviderSummary } from '../../shared/protocol'
import { AGENTS } from '../../shared/agents'
import type { AgentName } from '../../shared/agents'
import { getApi } from '../api'
import { attempt, useStore } from '../store/store'
import { ModelListEditor } from './ModelListEditor'
import { BASE_GROUPS, groupLabel, groupOfModel } from './ModelSelect'
import { ModelsDialog } from './ModelsDialog'
import { ParallelFields } from './ParallelFields'

const AGENT_LABEL: Record<AgentName, string> = { glossary: 'Glossary builder', translator: 'Translator', proofreader: 'Proofreader', qa: 'QA reviewer' }

/** A group is `paid` (every API provider) or a provider's id (Strata, LM Studio, a custom provider). */
type Group = string

interface Edit {
  enabled?: boolean
  baseUrl?: string
  concurrency?: number | 'auto'
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function ProviderRow({ p, edit, onEdit }: { p: ProviderSummary; edit: Edit | undefined; onEdit: (e: Edit) => void }) {
  const setModels = useStore((s) => s.setModels)
  const toast = useStore((s) => s.toast)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  // per minute / per day as typed: empty means no limit. Filled again when the saved value changes.
  const [rpm, setRpm] = useState(p.rpm ? String(p.rpm) : '')
  const [rpd, setRpd] = useState(p.rpd ? String(p.rpd) : '')
  useEffect(() => setRpm(p.rpm ? String(p.rpm) : ''), [p.rpm])
  useEffect(() => setRpd(p.rpd ? String(p.rpd) : ''), [p.rpd])
  const enabled = edit?.enabled ?? p.enabled
  const concurrency = edit?.concurrency ?? (p.concurrencyAuto ? 'auto' : p.concurrency)
  const auto = concurrency === 'auto'

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

  /** Sends the limits that changed: empty means no limit (0). */
  async function saveLimits() {
    const n = (v: string) => (v.trim() === '' ? 0 : Math.max(0, Math.round(Number(v))))
    const change: { rpm?: number; rpd?: number } = {}
    if (n(rpm) !== (p.rpm ?? 0) && Number.isFinite(n(rpm))) change.rpm = n(rpm)
    if (n(rpd) !== (p.rpd ?? 0) && Number.isFinite(n(rpd))) change.rpd = n(rpd)
    if (Object.keys(change).length === 0) return
    const info = await attempt(getApi().request<'setProviderLimits'>({ type: 'setProviderLimits', provider: p.id, ...change }))
    if (info) setModels(info)
  }

  const status = !p.available ? (
    <span className={enabled ? 'warn' : 'dim'}>{p.apiKeyEnv && !p.hasKey && p.enabled ? 'needs an API key' : (p.unavailableReason ?? 'unavailable')}</span>
  ) : p.down ? (
    <span className="warn" title="The server did not answer: it is skipped while another model is left. Press Check now when it runs.">down</span>
  ) : p.dayFull ? (
    <span className="warn">daily limit used, resets {clock(p.dayResetsAt)}</span>
  ) : (
    <span className="good">ready</span>
  )

  return (
    <tr data-testid={`provider-${p.id}`}>
      <td><input type="checkbox" checked={enabled} onChange={(e) => onEdit({ ...edit, enabled: e.target.checked })} title="Enabled" /></td>
      <td>
        <b>{p.name}</b>
        <div className="dim small">{p.name !== p.id ? `${p.id} \u00b7 ` : ''}{p.local ? 'local' : 'API'} &middot; {p.kind}{p.custom ? ' \u00b7 custom' : ''}</div>
      </td>
      <td><input value={edit?.baseUrl ?? p.baseUrl ?? ''} onChange={(e) => onEdit({ ...edit, baseUrl: e.target.value })} /></td>
      <td>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <input type="number" min={1} max={64} style={{ width: 52 }} disabled={auto} value={auto ? p.concurrency : concurrency} onChange={(e) => onEdit({ ...edit, concurrency: Number(e.target.value) })} data-testid={`parallel-${p.id}`} />
          {p.local && (
            <label className="row small" style={{ flexWrap: 'nowrap', gap: 2 }} title="The server's own slot count (checked every 10 seconds)">
              <input type="checkbox" checked={auto} onChange={(e) => onEdit({ ...edit, concurrency: e.target.checked ? 'auto' : p.concurrency })} data-testid={`auto-${p.id}`} />
              auto
            </label>
          )}
        </div>
      </td>
      <td>
        {p.local ? (
          <span className="dim">-</span>
        ) : (
          <div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
            <input type="number" min={0} style={{ width: 52 }} placeholder="min" title="Requests per minute (empty: no limit)" value={rpm} onChange={(e) => setRpm(e.target.value)} onBlur={() => void saveLimits()} onKeyDown={(e) => e.key === 'Enter' && void saveLimits()} data-testid={`rpm-${p.id}`} />
            <input type="number" min={0} style={{ width: 52 }} placeholder="day" title="Requests per day, from midnight UTC (empty: no limit)" value={rpd} onChange={(e) => setRpd(e.target.value)} onBlur={() => void saveLimits()} onKeyDown={(e) => e.key === 'Enter' && void saveLimits()} data-testid={`rpd-${p.id}`} />
          </div>
        )}
      </td>
      <td>
        {p.apiKeyEnv ? (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className={p.hasKey ? 'good' : 'dim'} style={{ minWidth: 62 }}>{p.hasKey ? 'key set' : 'no key'}</span>
            <input type="password" autoComplete="off" placeholder={p.hasKey ? 'replace key' : p.apiKeyEnv} value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 110 }} data-testid={`key-${p.id}`} />
            <button disabled={!key.trim() || saving} onClick={() => void saveKey()}>Save key</button>
          </div>
        ) : (
          <span className="dim">no key needed</span>
        )}
      </td>
      <td className="small">
        {status}
        {p.concurrencyAuto && p.available && !p.down && <div className="dim">{p.concurrency} slot(s)</div>}
        {p.rpd ? <div className="dim">today {p.requestsToday} of {p.rpd}</div> : null}
      </td>
    </tr>
  )
}

/** The saved defaults being edited. Fields that are undefined are unchanged. */
interface Draft {
  agents: Partial<Record<AgentName, string[]>>
  chunk?: number
  groups: Partial<Record<Group, string>>
  order?: Group[]
  shared?: boolean
  parallel?: ParallelSettings
  lm: Partial<{ parallel: number; context: number; ttlMinutes: number }>
}
const EMPTY_DRAFT: Draft = { agents: {}, groups: {}, lm: {} }

/** The MCP server card: switch, port, status, the token and copy-ready client setups. */
function McpCard() {
  const defaults = useStore((s) => s.defaults)
  const setDefaults = useStore((s) => s.setDefaults)
  const toast = useStore((s) => s.toast)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [enabled, setEnabled] = useState<boolean | undefined>()
  const [port, setPort] = useState<number | undefined>()
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const saved = defaults?.mcp ?? { enabled: false, port: 47811 }
  const on = enabled ?? saved.enabled
  const portValue = port ?? saved.port
  const dirty = on !== saved.enabled || portValue !== saved.port

  async function loadStatus() {
    const st = await attempt(getApi().request<'getMcpStatus'>({ type: 'getMcpStatus' }))
    if (st) setStatus(st)
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  async function save() {
    setSaving(true)
    const next = await attempt(getApi().request<'setDefaults'>({ type: 'setDefaults', patch: { mcp: { enabled: on, port: portValue } } }))
    if (next) {
      setDefaults(next)
      setEnabled(undefined)
      setPort(undefined)
      await loadStatus()
    }
    setSaving(false)
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${what} copied`, 'info')
    } catch (err) {
      toast((err as Error).message)
    }
  }

  const url = status?.url
  const token = status?.token
  const snippets = status?.running && url && token
    ? [
        { id: 'claude', title: 'Claude Code', text: `claude mcp add --transport http book-translator ${url} --header "Authorization: Bearer ${token}"` },
        { id: 'json', title: 'Clients with a JSON config (url + headers)', text: JSON.stringify({ mcpServers: { 'book-translator': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) }
      ]
    : []

  return (
    <div className="card stack">
      <div className="row spread">
        <h3>MCP server (use it from another LLM)</h3>
        <button className="primary" disabled={!dirty || saving} onClick={() => void save()} data-testid="mcp-save">{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="form">
        <label>Enable</label>
        <label className="row small">
          <input type="checkbox" checked={on} onChange={(e) => setEnabled(e.target.checked)} data-testid="mcp-enabled" />
          Let other programs use Book Translator over MCP
        </label>
        <label>Port</label>
        <input type="number" min={1024} max={65535} style={{ width: 100 }} value={portValue} onChange={(e) => setPort(Number(e.target.value))} data-testid="mcp-port" />
      </div>
      <div className="small" data-testid="mcp-status">
        {status?.running ? <span className="good">running at {url}</span> : status?.error ? <span className="warn">{status.error}</span> : <span className="dim">off</span>}
        {status?.enabled && !saved.enabled && <div className="dim">On for this run only (the app was started with --headless or --mcp).</div>}
      </div>
      {token && (
        <div className="row small" style={{ flexWrap: 'nowrap' }}>
          <span style={{ width: 50 }}>Token</span>
          <input readOnly className="grow" type={showToken ? 'text' : 'password'} value={token} data-testid="mcp-token" />
          <button onClick={() => setShowToken((v) => !v)}>{showToken ? 'Hide' : 'Show'}</button>
          <button onClick={() => void copy(token, 'Token')} data-testid="mcp-copy-token">Copy</button>
        </div>
      )}
      {snippets.map((sn) => (
        <div key={sn.id} className="stack" style={{ gap: 4 }}>
          <div className="row spread small">
            <span>{sn.title}</span>
            <button onClick={() => void copy(sn.text, sn.title)} data-testid={`mcp-copy-${sn.id}`}>Copy</button>
          </div>
          <pre className="small" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{showToken ? sn.text : sn.text.split(token!).join('********')}</pre>
        </div>
      ))}
      <div className="dim small">
        The client can work as an operator (it starts and watches the app's own translation, then reviews and exports) or as the translator (it translates the chunks itself and sends them back). It listens on 127.0.0.1 only and needs the token. The token is kept in the Windows credential store. Copy always copies the full text.
      </div>
    </div>
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
  const [checking, setChecking] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)

  useEffect(() => {
    void attempt(getApi().request<'listModels'>({ type: 'listModels' }).then(setModels))
  }, [setModels])

  const changed = Object.keys(edits).length > 0
  const dirty = Object.keys(draft.agents).length > 0 || Object.keys(draft.groups).length > 0 || Object.keys(draft.lm).length > 0 || draft.chunk !== undefined || draft.order !== undefined || draft.shared !== undefined || draft.parallel !== undefined

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

  async function checkNow() {
    setChecking(true)
    const info = await attempt(getApi().request<'checkServers'>({ type: 'checkServers' }))
    if (info) setModels(info)
    setChecking(false)
  }

  // the group order as shown: the saved order first, then the groups it doesn't name
  const savedOrder = defaults?.modelOrder ?? []
  const shared = draft.shared ?? savedOrder.length > 0
  // the groups that have a ticked model (or a saved default or place in the order), the saved order first, then API, Strata, LM Studio, then the providers
  const present = new Set<Group>([...savedOrder, ...Object.keys(defaults?.groupDefaults ?? {})])
  for (const m of models?.models ?? []) {
    const g = groupOfModel(models, m)
    if (g && m.shown !== false) present.add(g)
  }
  const known: Group[] = [...savedOrder, ...BASE_GROUPS, ...(models?.providers ?? []).map((p) => p.id)]
  const groups: Group[] = [...new Set(known)].filter((g) => present.has(g))
  const order: Group[] = draft.order ?? groups
  const groupOf = (g: Group) => draft.groups[g] ?? defaults?.groupDefaults[g] ?? ''
  const parallel: ParallelSettings = draft.parallel ?? defaults?.parallel ?? { enabled: true, maxAtOnce: 'auto', splitSections: false }
  const lm = { ...defaults?.lmstudio, ...draft.lm }

  function move(i: number, by: number) {
    const next = [...order]
    ;[next[i], next[i + by]] = [next[i + by]!, next[i]!]
    setDraft((d) => ({ ...d, order: next }))
  }

  async function saveDefaults() {
    const agentModels: Partial<Record<AgentName, string[]>> = {}
    for (const a of AGENTS) {
      const list = draft.agents[a]?.filter(Boolean)
      if (list && list.length > 0) agentModels[a] = list
    }
    const next = await attempt(
      getApi().request<'setDefaults'>({
        type: 'setDefaults',
        patch: {
          agentModels,
          defaultMaxChunkTokens: draft.chunk,
          groupDefaults: Object.keys(draft.groups).length > 0 ? draft.groups : undefined,
          modelOrder: draft.order !== undefined || draft.shared !== undefined ? (shared ? order : []) : undefined,
          lmstudio: Object.keys(draft.lm).length > 0 ? draft.lm : undefined,
          parallel: draft.parallel
        }
      })
    )
    if (next) {
      setDefaults(next)
      setDraft(EMPTY_DRAFT)
      toast('Defaults saved', 'info')
    }
  }

  const saveButton = (
    <button className="primary" disabled={!dirty} onClick={() => void saveDefaults()}>Save defaults</button>
  )

  /** One group's row: its place in the order, its default model (the models it may point at), and moving it. */
  function groupRow(g: Group, i: number) {
    const label = groupLabel(models, g)
    const value = groupOf(g)
    const refs = (models?.models ?? []).filter((m) => m.shown !== false && groupOfModel(models, m) === g).map((m) => m.ref)
    if (value && !refs.includes(value)) refs.unshift(value)
    return (
      <div key={g} className="row" style={{ flexWrap: 'nowrap', gap: 6 }} data-testid={`order-${g}`}>
        <span className="dim" style={{ width: 16 }}>{shared ? `${i + 1}.` : ''}</span>
        <span style={{ width: 90 }} title={label}>{label}</span>
        <select className="grow" value={value} onChange={(e) => setDraft((d) => ({ ...d, groups: { ...d.groups, [g]: e.target.value } }))} data-testid={`group-${g}`}>
          <option value="">(none)</option>
          {refs.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button disabled={i === 0} onClick={() => move(i, -1)} title="Try this group earlier" data-testid={`order-up-${g}`}>&uarr;</button>
        <button disabled={i === order.length - 1} onClick={() => move(i, 1)} title="Try this group later" data-testid={`order-down-${g}`}>&darr;</button>
      </div>
    )
  }

  return (
    <div className="page narrow stack">
      <h2>Settings</h2>

      <div className="card stack">
        <div className="row spread">
          <h3>Providers</h3>
          <div className="row">
            <button onClick={() => setModelsOpen(true)} data-testid="open-models">Models...</button>
            <button onClick={() => void checkNow()} disabled={checking} title="Check the Strata and LM Studio servers now" data-testid="check-servers">{checking ? 'Checking...' : 'Check now'}</button>
            <button onClick={() => void refresh()} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh local models'}</button>
            <button className="primary" disabled={!changed} onClick={() => void saveProviders()} data-testid="save-providers">Save providers</button>
          </div>
        </div>
        <table className="plain">
          <thead>
            <tr>
              <th style={{ width: 30 }} />
              <th style={{ width: 110 }}>Provider</th>
              <th>Base URL</th>
              <th style={{ width: 110 }}>Parallel</th>
              <th style={{ width: 120 }}>Per min / day</th>
              <th style={{ width: 290 }}>API key</th>
              <th style={{ width: 130 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {(models?.providers ?? []).map((p) => (
              <ProviderRow key={p.id} p={p} edit={edits[p.id]} onEdit={(e) => setEdits((x) => ({ ...x, [p.id]: e }))} />
            ))}
          </tbody>
        </table>
        <div className="dim small">
          Keys are stored in the Windows credential store (service "book-translator") and never shown again. An environment variable with the same name takes priority. Parallel is how many requests (and chapters) run at once; auto uses the slot count the server reports. Per minute and per day are saved when you leave the field (empty: no limit).
        </div>
        {(models?.discovery ?? []).map((d) => (
          <div key={d.provider} className="small">
            <b>{d.provider}</b>: {d.error ? <span className="warn">not reachable ({d.error})</span> : `${d.found} model(s) found`}
          </div>
        ))}
        <div className="dim small">Local models: load LM Studio models with a context of 32k or more, then press Refresh local models. Strata needs no refresh (128k context, set in its run config).</div>
      </div>

      <div className="card stack">
        <div className="row spread">
          <h3>Default models for a new translation</h3>
          {saveButton}
        </div>
        <div className="dim small">Each agent has an ordered list: the first model is tried first, the rest are fallbacks. A group default (API, Strata, LM Studio, or a provider you added) can stand in for a model in any list.</div>
        <div className="stack" style={{ gap: 4 }}>
          {order.map(groupRow)}
        </div>
        <label className="row small">
          <input type="checkbox" checked={shared} onChange={(e) => setDraft((d) => ({ ...d, shared: e.target.checked, order: e.target.checked ? order : undefined }))} data-testid="order-shared" />
          Use one fallback order for every agent
        </label>
        <div className="dim small">
          {shared ? 'Every list is sorted by the group order above: the first group is the primary, the rest are fallbacks.' : 'Each list keeps its own order. Tick the box to sort every list by the group order.'}
        </div>
        <div className="form">
          {AGENTS.map((a) => (
            <div key={a} style={{ display: 'contents' }}>
              <label style={{ alignSelf: 'start', paddingTop: 4 }}>{AGENT_LABEL[a]}</label>
              <ModelListEditor value={draft.agents[a] ?? defaults?.agentModels[a] ?? []} onChange={(list) => setDraft((d) => ({ ...d, agents: { ...d.agents, [a]: list } }))} testId={`default-${a}`} />
            </div>
          ))}
          <label>Chunk size (tokens)</label>
          <input type="number" min={200} max={20000} step={100} style={{ width: 100 }} value={draft.chunk ?? defaults?.defaultMaxChunkTokens ?? 1500} onChange={(e) => setDraft((d) => ({ ...d, chunk: Number(e.target.value) }))} />
        </div>
      </div>

      <div className="card stack">
        <div className="row spread">
          <h3>Parallel</h3>
          {saveButton}
        </div>
        <div className="form">
          <ParallelFields value={parallel} onChange={(v) => setDraft((d) => ({ ...d, parallel: v }))} testId="default-parallel" />
        </div>
        <div className="dim small">The starting values for a new translation. A project can change them in its Settings tab.</div>
      </div>

      <div className="card stack">
        <div className="row spread">
          <h3>LM Studio loading</h3>
          {saveButton}
        </div>
        <div className="form">
          <label>Requests at once</label>
          <input type="number" min={1} max={16} style={{ width: 100 }} value={lm.parallel ?? 4} onChange={(e) => setDraft((d) => ({ ...d, lm: { ...d.lm, parallel: Number(e.target.value) } }))} data-testid="lm-parallel" />
          <label>Context window</label>
          <input type="number" min={2048} step={1024} style={{ width: 100 }} value={lm.context ?? 131072} onChange={(e) => setDraft((d) => ({ ...d, lm: { ...d.lm, context: Number(e.target.value) } }))} data-testid="lm-context" />
          <label>Unload after idle min</label>
          <input type="number" min={1} style={{ width: 100 }} value={lm.ttlMinutes ?? 60} onChange={(e) => setDraft((d) => ({ ...d, lm: { ...d.lm, ttlMinutes: Number(e.target.value) } }))} data-testid="lm-ttl" />
        </div>
        <div className="dim small">When a model is not loaded yet, the engine loads it with these values. A model LM Studio has loaded already keeps its own settings.</div>
      </div>

      <McpCard />

      <div className="card stack">
        <h3>Files</h3>
        <div className="row">
          <button onClick={() => void attempt(getApi().openPath(''))}>Open data folder</button>
          <button onClick={() => void attempt(getApi().openPath('prompts'))}>Open prompts folder</button>
          <button onClick={() => void attempt(getApi().openPath('config'))}>Open config folder</button>
        </div>
        <div className="dim small">The prompts of the agents are plain Markdown files with {'{{variables}}'}. Edit them there, changes apply to the next chunk.</div>
      </div>

      {modelsOpen && <ModelsDialog onClose={() => setModelsOpen(false)} />}
    </div>
  )
}
