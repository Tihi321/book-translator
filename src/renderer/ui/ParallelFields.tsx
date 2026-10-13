import type { ParallelSettings } from '../../shared/project'

interface Props {
  value: ParallelSettings
  onChange: (v: ParallelSettings) => void
  disabled?: boolean
  testId?: string
}

/** The Parallel options: on/off, how many at once (Auto = the provider's limit), and splitting chapters. Rendered inside a `.form` grid. */
export function ParallelFields({ value, onChange, disabled, testId = 'parallel' }: Props) {
  const set = (patch: Partial<ParallelSettings>) => onChange({ ...value, ...patch })
  return (
    <>
      <label>Parallel</label>
      <label className="row small" style={{ color: 'var(--text)' }}>
        <input type="checkbox" checked={value.enabled} disabled={disabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid={`${testId}-enabled`} />
        Translate several chapters at the same time
      </label>
      <label>How many at once</label>
      <div className="row">
        <select value={String(value.maxAtOnce)} disabled={disabled || !value.enabled} onChange={(e) => set({ maxAtOnce: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })} data-testid={`${testId}-max`}>
          <option value="auto">Auto (the provider's limit)</option>
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i + 1} value={i + 1}>{i + 1}</option>
          ))}
        </select>
      </div>
      <span />
      <label className="row small" style={{ color: 'var(--text)' }}>
        <input type="checkbox" checked={value.splitSections} disabled={disabled || !value.enabled} onChange={(e) => set({ splitSections: e.target.checked })} data-testid={`${testId}-split`} />
        Also split chapters (faster, loses the previous-passage context)
      </label>
    </>
  )
}
