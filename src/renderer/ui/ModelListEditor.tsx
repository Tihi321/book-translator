import { useStore } from '../store/store'
import type { AliasOption } from './ModelSelect'
import { groupLabel, ModelSelect, pickDefault } from './ModelSelect'

/** The alias options for the fallback list: kind for the first row, kind-n for the n-th row. */
export function useAliasOptions(): AliasOption[] {
  const defaults = useStore((s) => s.defaults)
  const models = useStore((s) => s.models)
  const fallbacks = defaults?.fallbacks ?? []
  const providers = models?.providers ?? []
  const count = new Map<string, number>()
  const seen = new Set<string>()
  const options: AliasOption[] = []

  for (const ref of fallbacks) {
    const m = models?.models.find((x) => x.ref === ref)
    const p = providers.find((x) => x.id === ref.split('/')[0])
    const kind = m?.kind ?? (p?.local || p?.custom ? p.id : 'paid')
    const n = (count.get(kind) ?? 0) + 1
    count.set(kind, n)
    const alias = n === 1 ? kind : `${kind}-${n}`
    const name = kind === 'paid' ? 'API' : (p?.custom ? p.name : kind)
    if (!seen.has(alias)) {
      seen.add(alias)
      options.push({ value: alias, label: `${alias} (${name}: ${ref})` })
    }
  }

  // Also include any groupDefaults not covered
  for (const [g, ref] of Object.entries(defaults?.groupDefaults ?? {})) {
    if (ref && !seen.has(g)) {
      seen.add(g)
      options.push({ value: g, label: `${groupLabel(models, g)} default (${ref})` })
    }
  }

  return options
}

interface Props {
  value: string[]
  onChange: (list: string[]) => void
  disabled?: boolean
  testId?: string
}

/** An ordered fallback list: the first model is tried first, the rest are fallbacks. */
export function ModelListEditor({ value, onChange, disabled, testId }: Props) {
  const models = useStore((s) => s.models)
  const aliases = useAliasOptions()
  const set = (i: number, ref: string) => onChange(value.map((r, k) => (k === i ? ref : r)))
  const move = (i: number, by: number) => {
    const next = [...value]
    ;[next[i], next[i + by]] = [next[i + by]!, next[i]!]
    onChange(next)
  }
  const add = () => {
    const fresh = models?.models.find((m) => m.available && m.shown !== false && !value.includes(m.ref))?.ref ?? pickDefault(models, [])
    if (fresh) onChange([...value, fresh])
  }
  return (
    <div className="stack" style={{ gap: 4 }} data-testid={testId}>
      {value.length === 0 && <span className="dim">(no model)</span>}
      {value.map((ref, i) => (
        <div key={i} className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
          <span className="dim" style={{ width: 16 }}>{i + 1}.</span>
          <div className="grow">
            <ModelSelect models={models} value={ref} onChange={(r) => set(i, r)} aliases={aliases} disabled={disabled} testId={testId ? `${testId}-${i}` : undefined} />
          </div>
          <button disabled={disabled || i === 0} onClick={() => move(i, -1)} title="Try earlier">&uarr;</button>
          <button disabled={disabled || i === value.length - 1} onClick={() => move(i, 1)} title="Try later">&darr;</button>
          <button disabled={disabled || (value.length === 1 && i === 0)} onClick={() => onChange(value.filter((_, k) => k !== i))} title="Remove">&times;</button>
        </div>
      ))}
      <div>
        <button disabled={disabled} onClick={add} data-testid={testId ? `${testId}-add` : undefined}>+ Add fallback</button>
      </div>
    </div>
  )
}
