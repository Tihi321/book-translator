import { useMemo, useState } from 'react'
import { getApi } from '../api'
import { fmtContext } from '../format'
import { attempt, useStore } from '../store/store'

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
  const catalogs = useStore((s) => s.catalogs)
  const detectModels = useStore((s) => s.detectModels)
  const setModels = useStore((s) => s.setModels)
  const providers = models?.providers ?? []
  const [provider, setProvider] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [shownOnly, setShownOnly] = useState(false)
  const [add, setAdd] = useState({ id: '', priceIn: '', priceOut: '', context: '' })

  const current = providers.find((p) => p.id === provider) ?? providers.find((p) => p.available) ?? providers[0]
  const catalog = current ? catalogs[current.id] : undefined
  const local = !!current?.local

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
        <div className="dim small">Tick the models the pickers offer. Saved in config/models.md.</div>
        <div className="models-body">
          <div className="models-providers">
            {providers.map((p) => (
              <button key={p.id} className={p.id === current?.id ? 'primary' : ''} onClick={() => setProvider(p.id)} data-testid={`models-provider-${p.id}`} title={p.available ? undefined : p.unavailableReason}>
                <span>{p.id}</span>
                <span className="small">{p.available ? `${(models?.models ?? []).filter((m) => m.provider === p.id && m.shown !== false).length} ticked` : 'n/a'}</span>
              </button>
            ))}
          </div>
          {current ? (
            <div className="models-pane">
              <div className="row">
                <input className="grow" value={filter} placeholder="Filter, e.g. qwen" onChange={(e) => setFilter(e.target.value)} data-testid="models-filter" />
                <button disabled={!current.available || catalog?.loading} onClick={() => void detectModels(current.id)} title={`Ask ${current.id} for every model it has`} data-testid="models-detect">
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
