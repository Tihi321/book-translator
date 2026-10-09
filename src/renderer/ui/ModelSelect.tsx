import type { ModelSummary, ModelsInfo } from '../../shared/protocol'
import { fmtContext } from '../format'

export function modelLabel(m: ModelSummary): string {
  const price = m.local ? 'free' : m.priceIn === 0 && m.priceOut === 0 ? 'free' : `$${m.priceIn}/$${m.priceOut} per 1M`
  return `${m.model}  |  ${fmtContext(m.context)} ctx${m.local && !m.loaded ? ' (default)' : ''}  |  ${price}`
}

/** The first of the preferred refs that can be used now, else the first usable model, else ''. */
export function pickDefault(models: ModelsInfo | null, preferred: readonly string[] | undefined): string {
  if (!models) return ''
  // local models first: they are free
  const usable = models.models.filter((m) => m.available).sort((a, b) => Number(b.local) - Number(a.local))
  for (const ref of preferred ?? []) if (usable.some((m) => m.ref === ref)) return ref
  return usable[0]?.ref ?? ''
}

interface Props {
  models: ModelsInfo | null
  value: string
  onChange: (ref: string) => void
  disabled?: boolean
  /** Show models of providers that are switched off or have no key (greyed out). */
  showUnavailable?: boolean
  testId?: string
  /** An extra first option with the value '' (for example "same as the project"). */
  emptyLabel?: string
}

/** A plain select with the models in two groups per provider kind: Local (free, on this machine) and API. */
export function ModelSelect({ models, value, onChange, disabled, showUnavailable, testId, emptyLabel }: Props) {
  const list = (models?.models ?? []).filter((m) => m.available || showUnavailable)
  const groups = new Map<string, ModelSummary[]>()
  for (const m of list) {
    const key = `${m.local ? 'Local' : 'API'} - ${m.provider}`
    groups.set(key, [...(groups.get(key) ?? []), m])
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => Number(b.startsWith('Local')) - Number(a.startsWith('Local')) || a.localeCompare(b))
  const known = value === '' ? emptyLabel !== undefined : list.some((m) => m.ref === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-testid={testId}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {!known && <option value={value}>{value || '(no model available)'}</option>}
      {ordered.map(([label, ms]) => (
        <optgroup key={label} label={label}>
          {ms.map((m) => (
            <option key={m.ref} value={m.ref} disabled={!m.available}>
              {modelLabel(m)}
              {m.available ? '' : '  (unavailable)'}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
