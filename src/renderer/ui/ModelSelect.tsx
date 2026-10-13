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

export const GROUP_ALIASES = ['paid', 'strata', 'lmstudio'] as const

/** The saved list to start from: kept entries are aliases or usable models; when none is left, the first usable model. */
export function seedList(models: ModelsInfo | null, preferred: readonly string[] | undefined): string[] {
  if (!models) return [...(preferred ?? [])]
  const kept = (preferred ?? []).filter((r) => (GROUP_ALIASES as readonly string[]).includes(r) || models.models.some((m) => m.ref === r && m.available))
  if (kept.length > 0) return kept
  const first = pickDefault(models, preferred)
  return first ? [first] : []
}

export interface AliasOption {
  value: string
  label: string
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
  /** Extra first options, such as "API default (...)": values that are not model refs. */
  aliases?: AliasOption[]
}

/** A plain select with the models in two groups per provider kind: Local (free, on this machine) and API. */
export function ModelSelect({ models, value, onChange, disabled, showUnavailable, testId, emptyLabel, aliases }: Props) {
  // models hidden in the Models dialog are not offered, unless one is the current value
  const list = (models?.models ?? []).filter((m) => (m.available || showUnavailable) && (m.shown !== false || m.ref === value))
  const groups = new Map<string, ModelSummary[]>()
  for (const m of list) {
    const key = `${m.local ? 'Local' : 'API'} - ${m.provider}`
    groups.set(key, [...(groups.get(key) ?? []), m])
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => Number(b.startsWith('Local')) - Number(a.startsWith('Local')) || a.localeCompare(b))
  const known = value === '' ? emptyLabel !== undefined : list.some((m) => m.ref === value) || !!aliases?.some((a) => a.value === value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-testid={testId}>
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {!known && <option value={value}>{value || '(no model available)'}</option>}
      {aliases?.map((a) => (
        <option key={a.value} value={a.value}>{a.label}</option>
      ))}
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
