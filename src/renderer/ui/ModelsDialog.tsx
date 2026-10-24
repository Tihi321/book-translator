import { useMemo, useState } from 'react'
import { getApi } from '../api'
import { fmtContext } from '../format'
import { attempt, useStore } from '../store/store'
import { CustomProviderForm } from './CustomProviderForm'
import type { ModelSummary, ProviderSummary } from '../../shared/protocol'

function kindLabel(kind: string, providers: ProviderSummary[]): string {
  if (kind === 'paid') return 'API'
  const p = providers.find((x) => x.id === kind)
  return p?.custom ? p.name : kind
}

function rowKind(ref: string, models: ModelSummary[], providers: ProviderSummary[]): string {
  const m = models.find((x) => x.ref === ref)
  if (m) return m.kind
  const p = providers.find((x) => x.id === ref.split('/')[0])
  return p?.local || p?.custom ? p.id : 'paid'
}

interface Row {
  ref: string
  id: string
  context?: number
  priceIn?: number
  priceOut?: number
  /** In the pickers now. */
  shown: boolean
  source?: 'providers.md' | 'found' | 'added'
  /** It can be ticked: known, local, or listed with a price. */
  pickable: boolean
}

function formatPrice(r: Row, local: boolean): string {
  if (local) return 'local'
  if (r.priceIn === undefined || r.priceOut === undefined) return 'no price'
  if (r.priceIn === 0 && r.priceOut === 0) return 'free'
  const f = (x: number) => `$${+x.toPrecision(3)}`
  return `${f(r.priceIn)} / ${f(r.priceOut)}`
}

/** Which models the pickers offer (config/models.md): detect what a provider has, tick or hide, add a model by its id. */
export function ModelsDialog({ onClose }: { onClose: () => void }) {
  const models = useStore((s) => s.models)
  const defaults = useStore((s) => s.defaults)
  const setDefaults = useStore((s) => s.setDefaults)
  const catalogs = useStore((s) => s.catalogs)
  const detectModels = useStore((s) => s.detectModels)
  const setModels = useStore((s) => s.setModels)
  const providers = models?.providers ?? []
  const [provider, setProvider] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [shownOnly, setShownOnly] = useState(false)
  const [add, setAdd] = useState({ id: '', priceIn: '', priceOut: '', context: '' })
  /** The provider form: 'new', or the id of the custom provider being edited. */
  const [form, setForm] = useState<'new' | string | null>(null)
  const [removing, setRemoving] = useState(false)

  const current = providers.find((p) => p.id === provider) ?? providers.find((p) => p.available) ?? providers[0]
  const catalog = current ? catalogs[current.id] : undefined
  const local = !!current?.local

  // Fallback models state & actions
  const shared = defaults?.fallbackShared ?? false
  const fallbacks = defaults?.fallbacks ?? []

  const saveFallbackSettings = async (patch: { fallbacks?: string[]; fallbackShared?: boolean }) => {
    const next = await attempt(getApi().request<'setDefaults'>({ type: 'setDefaults', patch }))
    if (next) setDefaults(next)
  }
  const saveFallbacks = (next: string[]) => void saveFallbackSettings({ fallbacks: next })
  const moveFallback = (i: number, by: number) => {
    const next = [...fallbacks]
    ;[next[i], next[i + by]] = [next[i + by]!, next[i]!]
    void saveFallbacks(next)
  }

  const allModels = models?.models ?? []
  const ticked = allModels.filter((m) => m.shown !== false && m.available)
  const kindsFor = (own: string): string[] => {
    const kinds = ['paid', ...providers.filter((p) => (p.local || p.custom) && p.kind !== 'client').map((p) => p.id), ...providers.filter((p) => p.kind === 'client').map((p) => p.id)]
    return kinds.filter((k) => k === own || ticked.some((m) => m.kind === k))
  }
  const kindsOfRows = fallbacks.map((r) => rowKind(r, allModels, providers))
  const seenKinds = new Map<string, number>()

  const fallbackRow = (ref: string, i: number) => {
    const kind = kindsOfRows[i]!
    const n = (seenKinds.get(kind) ?? 0) + 1
    seenKinds.set(kind, n)
    const alias = n === 1 ? kind : `${kind}-${n}`
    const refs = ticked.filter((m) => m.kind === kind).map((m) => m.ref)
    if (!refs.includes(ref)) refs.unshift(ref)
    return (
      <div key={i} className="row" style={{ flexWrap: 'nowrap', gap: 6 }} data-testid={`fallback-row-${i}`}>
        <span className="dim small" style={{ width: 16 }}>{shared ? `${i + 1}.` : ''}</span>
        <span className="dim small" style={{ width: 70 }} title={`The name roles.md uses for this row: ${alias}`} data-testid={`fallback-alias-${i}`}>
          {alias}
        </span>
        <select
          value={kind}
          onChange={(e) => {
            const first = ticked.find((m) => m.kind === e.target.value)
            if (first) void saveFallbacks(fallbacks.map((r, j) => (j === i ? first.ref : r)))
          }}
          style={{ width: 90 }}
          data-testid={`fallback-kind-${i}`}
        >
          {kindsFor(kind).map((k) => (
            <option key={k} value={k}>
              {kindLabel(k, providers)}
            </option>
          ))}
        </select>
        <select value={ref} onChange={(e) => void saveFallbacks(fallbacks.map((r, j) => (j === i ? e.target.value : r)))} style={{ flex: 1, minWidth: 0 }} data-testid={`fallback-model-${i}`}>
          {refs.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button disabled={i === 0} onClick={() => void moveFallback(i, -1)} title="Try this row earlier" data-testid={`fallback-up-${i}`}>
          &uarr;
        </button>
        <button disabled={i === fallbacks.length - 1} onClick={() => void moveFallback(i, 1)} title="Try this row later" data-testid={`fallback-down-${i}`}>
          &darr;
        </button>
        <button disabled={fallbacks.length <= 1} onClick={() => void saveFallbacks(fallbacks.filter((_, j) => j !== i))} title="Remove this row" data-testid={`fallback-remove-${i}`}>
          &times;
        </button>
      </div>
    )
  }

  const addFallbackRow = () => {
    const first = ticked.find((m) => m.kind === 'paid') ?? ticked[0]
    if (first) void saveFallbacks([...fallbacks, first.ref])
  }

  const rows = useMemo<Row[]>(() => {
    if (!current) return []
    const out = new Map<string, Row>()
    for (const m of models?.models ?? []) {
      if (m.provider !== current.id) continue
      out.set(m.ref, { ref: m.ref, id: m.model, context: m.context, priceIn: m.priceIn, priceOut: m.priceOut, shown: m.shown !== false, source: m.picked ? 'added' : m.discovered ? 'found' : 'providers.md', pickable: true })
    }
    for (const c of catalog?.models ?? []) {
      const known = out.get(c.ref)
      if (known) out.set(c.ref, { ...known, context: known.context ?? c.context })
      else out.set(c.ref, { ref: c.ref, id: c.id, context: c.context, priceIn: c.priceIn, priceOut: c.priceOut, shown: false, pickable: c.pickable })
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
  }, [current, models, catalog])

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const visible = rows.filter((r) => words.every((w) => r.id.toLowerCase().includes(w)) && (!freeOnly || local || (r.priceIn === 0 && r.priceOut === 0)) && (!shownOnly || r.shown))
  const toShow = visible.filter((r) => !r.shown && r.pickable).map((r) => r.ref)
  const toHide = visible.filter((r) => r.shown).map((r) => r.ref)

  async function show(refs: string[], on: boolean) {
    if (!current) return
    const info = await attempt(getApi().request<'showModels'>({ type: 'showModels', provider: current.id, refs, show: on }))
    if (info) setModels(info)
  }

  async function removeProvider() {
    if (!current?.custom) return
    const info = await attempt(getApi().request<'removeCustomProvider'>({ type: 'removeCustomProvider', id: current.id }))
    setRemoving(false)
    if (info) {
      setModels(info)
      setProvider(null)
    }
  }

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
  const addPriceOk = local || (num(add.priceIn) !== undefined && num(add.priceIn)! >= 0 && num(add.priceOut) !== undefined && num(add.priceOut)! >= 0)
  const canAdd = !!current && add.id.trim() !== '' && addPriceOk
  async function addModel() {
    if (!current || !canAdd) return
    const info = await attempt(getApi().request<'addModel'>({ type: 'addModel', provider: current.id, id: add.id.trim(), priceIn: num(add.priceIn), priceOut: num(add.priceOut), context: num(add.context) }))
    if (info) {
      setModels(info)
      setAdd({ id: '', priceIn: '', priceOut: '', context: '' })
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog models" onClick={(e) => e.stopPropagation()} data-testid="models-dialog">
        <h3>Models</h3>
        <div className="dim small">Fallback models: each row is a kind (API, Strata, LM Studio ...) and its model. roles.md names a kind for its first row (paid, strata, lmstudio ...) and kind-2, kind-3 for the next ones.</div>
        <label className="row small">
          <input type="checkbox" checked={shared} onChange={(e) => void saveFallbackSettings({ fallbackShared: e.target.checked })} data-testid="order-shared" />
          One fallback order for every role
        </label>
        <div className="stack" style={{ gap: 4 }}>
          {fallbacks.map((r, i) => fallbackRow(r, i))}
        </div>
        <div className="row">
          <button onClick={addFallbackRow} disabled={ticked.length === 0} data-testid="fallback-add">
            Add a fallback
          </button>
        </div>
        <div className="dim small">
          {shared
            ? "Every role tries these top to bottom: the first is the primary, the rest are fallbacks. A role's own model of the same kind (Strata's -low for the checks) takes that row's place. An agent's own model still goes first. Running jobs switch at once."
            : 'Each role keeps the order of its list in roles.md. The rows set what paid, paid-2, strata, lmstudio ... stand for.'}
        </div>
        <hr />
        <div className="dim small">Tick the models the pickers offer. Saved in config/models.md.</div>
        <div className="models-body">
          <div className="models-providers">
            {providers.map((p) => (
              <button key={p.id} className={p.id === current?.id ? 'primary' : ''} onClick={() => setProvider(p.id)} data-testid={`models-provider-${p.id}`} title={p.available ? undefined : p.unavailableReason}>
                <span>{p.name}</span>
                <span className="small">{p.available ? `${(models?.models ?? []).filter((m) => m.provider === p.id && m.shown !== false).length} ticked` : 'n/a'}</span>
              </button>
            ))}
            <button onClick={() => setForm('new')} data-testid="models-add-provider">+ Add provider</button>
          </div>
          {form !== null ? (
            <CustomProviderForm
              key={form}
              provider={form === 'new' ? undefined : providers.find((p) => p.id === form)}
              onDone={(id) => {
                setForm(null)
                if (id) setProvider(id)
              }}
            />
          ) : current ? (
            <div className="models-pane">
              {current.custom && (
                <div className="row small" data-testid="models-custom-actions">
                  <span className="dim">Added provider</span>
                  <button onClick={() => setForm(current.id)} data-testid="models-edit-provider">Edit</button>
                  {removing ? (
                    <>
                      <span className="warn">Remove {current.name}, its key and its ticked models?</span>
                      <button className="primary" onClick={() => void removeProvider()} data-testid="models-remove-confirm">Remove</button>
                      <button onClick={() => setRemoving(false)}>Keep</button>
                    </>
                  ) : (
                    <button onClick={() => setRemoving(true)} data-testid="models-remove-provider">Remove</button>
                  )}
                </div>
              )}
              <div className="row">
                <input className="grow" value={filter} placeholder="Filter, e.g. qwen" onChange={(e) => setFilter(e.target.value)} data-testid="models-filter" />
                <button disabled={!current.available || catalog?.loading} onClick={() => void detectModels(current.id)} title={`Ask ${current.name} for every model it has`} data-testid="models-detect">
                  {catalog?.loading ? 'Detecting...' : 'Detect models'}
                </button>
              </div>
              <div className="row" style={{ gap: 12 }}>
                {!local && (
                  <label className="row small">
                    <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} data-testid="models-free" />
                    free only
                  </label>
                )}
                <label className="row small">
                  <input type="checkbox" checked={shownOnly} onChange={(e) => setShownOnly(e.target.checked)} />
                  ticked only
                </label>
                <span className="dim small" style={{ marginLeft: 'auto' }} data-testid="models-status">
                  {!current.available ? (current.unavailableReason ?? 'not available') : catalog?.error ? `Could not list: ${catalog.error}` : catalog?.at ? `${catalog.models.length} listed, ${rows.filter((r) => r.shown).length} ticked` : 'Detect models lists everything it has'}
                </span>
              </div>
              <div className="row">
                <button disabled={!toShow.length} onClick={() => void show(toShow, true)} data-testid="models-tick-all">Tick all {toShow.length || ''}</button>
                <button disabled={!toHide.length} onClick={() => void show(toHide, false)} data-testid="models-untick-all">Untick all {toHide.length || ''}</button>
                <span className="dim small">of the ones listed below</span>
              </div>
              <div className="models-list" data-testid="models-list">
                {visible.map((r) => (
                  <label key={r.ref} className={`model-row${r.pickable ? '' : ' disabled'}`} title={r.pickable ? r.ref : 'No listed price, so the budget could not count it: add it by id below with its price'} data-testid={`model-row-${r.ref}`}>
                    <input type="checkbox" checked={r.shown} disabled={!r.pickable} onChange={(e) => void show([r.ref], e.target.checked)} />
                    <span className="model-id">{r.id}</span>
                    <span className="dim">{r.context ? fmtContext(r.context) : ''}</span>
                    <span className={r.priceIn === 0 && r.priceOut === 0 && !local ? 'good' : 'dim'}>{formatPrice(r, local)}</span>
                    <span className="dim">{r.source ?? ''}</span>
                  </label>
                ))}
                {!visible.length && <div className="dim">{catalog?.loading ? 'Asking the provider...' : 'No models here.'}</div>}
              </div>
              <div className="dim small">Add a model by its id{local ? '' : ', with its price in USD per 1M tokens (0 and 0 for a free one)'}:</div>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input value={add.id} placeholder={current.id === 'openrouter' ? 'e.g. qwen/qwen3-235b-a22b:free' : 'model id'} onChange={(e) => setAdd({ ...add, id: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void addModel()} style={{ flex: 3 }} data-testid="models-add-id" />
                {!local && (
                  <>
                    <input type="number" min={0} step="any" value={add.priceIn} placeholder="$ in" onChange={(e) => setAdd({ ...add, priceIn: e.target.value })} style={{ flex: 1 }} data-testid="models-add-in" />
                    <input type="number" min={0} step="any" value={add.priceOut} placeholder="$ out" onChange={(e) => setAdd({ ...add, priceOut: e.target.value })} style={{ flex: 1 }} data-testid="models-add-out" />
                  </>
                )}
                <input type="number" min={0} value={add.context} placeholder="context" onChange={(e) => setAdd({ ...add, context: e.target.value })} style={{ flex: 1 }} data-testid="models-add-context" />
                <button disabled={!canAdd} onClick={() => void addModel()} data-testid="models-add">Add</button>
              </div>
            </div>
          ) : (
            <div className="dim">No model providers in providers.md.</div>
          )}
        </div>
        <div className="row spread">
          <span className="dim small">Prices are USD per 1M tokens in / out.</span>
          <button onClick={onClose} data-testid="models-close">Close</button>
        </div>
      </div>
    </div>
  )
}
