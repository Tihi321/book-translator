import { useStore } from '../store/store'
import type { AliasOption } from './ModelSelect'
import { groupLabel, ModelSelect, pickDefault } from './ModelSelect'

/** The alias options for the groups that have a default model set (API, Strata, LM Studio, and a custom provider's group). */
export function useAliasOptions(): AliasOption[] {
  const groups = useStore((s) => s.defaults?.groupDefaults)
  const models = useStore((s) => s.models)
  return Object.entries(groups ?? {})
    .filter(([, ref]) => ref)
    .map(([g, ref]) => ({ value: g, label: `${groupLabel(models, g)} default (${ref})` }))
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
