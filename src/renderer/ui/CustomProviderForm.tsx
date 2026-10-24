import { useState } from 'react'
import type { CustomProviderForm as FormValues, CustomProviderTest, ProviderSummary } from '../../shared/protocol'
import { getApi } from '../api'
import { attempt, useStore } from '../store/store'

interface Props {
  /** The custom provider to edit. Missing: a new one. */
  provider?: ProviderSummary
  onDone: (id?: string) => void
}

/** The Add provider / Edit provider form of the Models dialog: any OpenAI-compatible server, saved to config/providers.md. */
export function CustomProviderForm({ provider, onDone }: Props) {
  const setModels = useStore((s) => s.setModels)
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? 'http://127.0.0.1:')
  const [apiKey, setApiKey] = useState('')
  const [free, setFree] = useState(provider?.local ?? true)
  const [jsonSchema, setJsonSchema] = useState(provider?.jsonSchema ?? false)
  const [auto, setAuto] = useState(provider?.concurrencyAuto ?? false)
  const [parallel, setParallel] = useState(provider && !provider.concurrencyAuto ? provider.concurrency : 2)
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [test, setTest] = useState<CustomProviderTest | 'running' | null>(null)
  const [saving, setSaving] = useState(false)

  const valid = name.trim() !== '' && /^https?:\/\/\S+$/i.test(baseUrl.trim()) && (auto || (Number.isInteger(parallel) && parallel >= 1))

  async function runTest() {
    setTest('running')
    const res = await attempt(getApi().request<'testCustomProvider'>({ type: 'testCustomProvider', baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, id: provider?.id }))
    setTest(res ?? { ok: false, error: 'the test failed' })
  }

  async function save() {
    setSaving(true)
    const form: FormValues = { id: provider?.id, name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, free, jsonSchema, concurrency: auto ? 'auto' : parallel, enabled }
    const info = await attempt(getApi().request<'saveCustomProvider'>({ type: 'saveCustomProvider', ...form }))
    setSaving(false)
    if (info) {
      setModels(info)
      onDone(provider?.id ?? info.providers.find((p) => p.custom && p.name === name.trim())?.id)
    }
  }

  return (
    <div className="models-pane stack" data-testid="provider-form">
      <b>{provider ? `Edit ${provider.name}` : 'Add provider'}</b>
      <div className="dim small">Any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, the ACP proxy ...). Saved to config/providers.md; the key goes to the Windows credential store.</div>
      <div className="form">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ACP proxy (home)" data-testid="provider-form-name" />
        <label>Base URL</label>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:7461/v1" data-testid="provider-form-url" />
        <label>API key</label>
        <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider?.hasKey ? 'key set (type to replace it)' : 'optional'} data-testid="provider-form-key" />
        <label>Free (local)</label>
        <label className="row small">
          <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} data-testid="provider-form-free" />
          No key needed, no budget. Unticked: a paid API, its models need prices.
        </label>
        <label>Send JSON schema</label>
        <label className="row small">
          <input type="checkbox" checked={jsonSchema} onChange={(e) => setJsonSchema(e.target.checked)} data-testid="provider-form-schema" />
          Off for servers that reject or ignore it (the prompt and the repair step handle the JSON).
        </label>
        <label>Parallel</label>
        <div className="row small">
          <input type="number" min={1} max={64} style={{ width: 70 }} disabled={auto} value={parallel} onChange={(e) => setParallel(Number(e.target.value))} data-testid="provider-form-parallel" />
          <label className="row small">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="provider-form-auto" />
            auto (the server's own slot count)
          </label>
        </div>
        <label>Enabled</label>
        <label className="row small">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="provider-form-enabled" />
          Use this provider
        </label>
      </div>
      <div className="row">
        <button disabled={!/^https?:\/\/\S+$/i.test(baseUrl.trim()) || test === 'running'} onClick={() => void runTest()} data-testid="provider-form-test">{test === 'running' ? 'Testing...' : 'Test'}</button>
        {test && test !== 'running' && (
          <span className={test.ok ? 'good small' : 'warn small'} data-testid="provider-form-test-result">
            {test.ok ? `reachable, ${test.models} model${test.models === 1 ? '' : 's'}` : `not reachable: ${test.error}`}
          </span>
        )}
        <span className="grow" />
        <button onClick={() => onDone()} data-testid="provider-form-cancel">Cancel</button>
        <button className="primary" disabled={!valid || saving} onClick={() => void save()} data-testid="provider-form-save">{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </div>
  )
}
