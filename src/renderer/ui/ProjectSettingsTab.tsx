import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ProjectSettings } from '../../shared/project'
import type { ProjectDetail } from '../../shared/protocol'
import { AGENTS } from '../../shared/agents'
import type { AgentName } from '../../shared/agents'
import { getApi } from '../api'
import { attempt, useStore } from '../store/store'
import { ModelListEditor } from './ModelListEditor'
import { ParallelFields } from './ParallelFields'

const AGENT_LABEL: Record<AgentName, string> = { glossary: 'Glossary builder', translator: 'Translator', proofreader: 'Proofreader', qa: 'QA reviewer' }

function AgentRow({ agent, enabled, onEnabled, disabled, children }: { agent: AgentName; enabled: boolean; onEnabled: (v: boolean) => void; disabled: boolean; children: ReactNode }) {
  return (
    <>
      <label className="row" style={{ color: 'var(--text)', alignSelf: 'start', paddingTop: 4 }}>
        {agent === 'translator' ? <input type="checkbox" checked disabled /> : <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => onEnabled(e.target.checked)} data-testid={`settings-enable-${agent}`} />}
        {AGENT_LABEL[agent]}
      </label>
      {children}
    </>
  )
}

/** The project's settings after it was created: models, agents, parallel, chunk size. Locked while the project runs. */
export function ProjectSettingsTab({ detail }: { detail: ProjectDetail }) {
  const loadDetail = useStore((s) => s.loadDetail)
  const toast = useStore((s) => s.toast)
  const [draft, setDraft] = useState<Partial<ProjectSettings>>({})
  const [saving, setSaving] = useState(false)
  const locked = detail.running
  const id = detail.project.id
  const s: ProjectSettings = { ...detail.project.settings, ...draft }
  const dirty = Object.keys(draft).length > 0
  const set = (patch: Partial<ProjectSettings>) => setDraft((d) => ({ ...d, ...patch }))

  async function save() {
    setSaving(true)
    const patch: Partial<ProjectSettings> = { ...draft }
    if (patch.agentModels) patch.agentModels = Object.fromEntries(AGENTS.map((a) => [a, patch.agentModels![a].filter(Boolean)])) as Record<AgentName, string[]>
    const res = await attempt(getApi().request<'updateProjectSettings'>({ type: 'updateProjectSettings', projectId: id, patch }))
    if (res) {
      setDraft({})
      await loadDetail(id)
      toast('Project settings saved', 'info')
    }
    setSaving(false)
  }

  return (
    <div className="card stack" data-testid="project-settings">
      {locked && <div className="note">Pause the project to change its settings.</div>}
      <div className="form">
        {AGENTS.map((a) => (
          <AgentRow key={a} agent={a} enabled={a === 'translator' ? true : s.enabled[a]} onEnabled={(v) => set({ enabled: { ...s.enabled, [a]: v } })} disabled={locked}>
            <ModelListEditor value={s.agentModels[a]} onChange={(list) => set({ agentModels: { ...s.agentModels, [a]: list } })} disabled={locked || (a !== 'translator' && !s.enabled[a])} testId={`settings-model-${a}`} />
          </AgentRow>
        ))}
        <span />
        <label className="row small">
          <input type="checkbox" checked={s.pauseAfterGlossary} disabled={locked || !s.enabled.glossary} onChange={(e) => set({ pauseAfterGlossary: e.target.checked })} />
          Pause after the glossary, so I can review it
        </label>
        <span />
        <label className="row small" title="Off: only major QA issues go to the fixer and minor ones stay in the text (see the chunk's QA list). On: the fixer gets the minor ones too, and the chunk is checked again.">
          <input type="checkbox" checked={s.fixMinorIssues === true} disabled={locked || !s.enabled.qa} onChange={(e) => set({ fixMinorIssues: e.target.checked })} data-testid="settings-fix-minor" />
          Also fix minor QA issues
        </label>
        {(detail.project.format === 'vn' || detail.project.format === 'vnp') && (
          <>
            <span />
            <label className="row small" title={detail.project.format === 'vnp' ? 'The glossary gives each character and alias name a form for the target language; the translator writes it into the name values and wherever a name appears in the text. Chunks that are already translated keep the names they have.' : 'The glossary gives each character a name for the target language; the export writes it into the speaker tags, the ON SCREEN: lines and the bible. Chunks that are already translated keep the names they have.'}>
              <input type="checkbox" checked={s.localizeNames === true} disabled={locked} onChange={(e) => set({ localizeNames: e.target.checked })} data-testid="settings-localize-names" />
              Localize the character names
            </label>
          </>
        )}
        <ParallelFields value={s.parallel} onChange={(v) => set({ parallel: v })} disabled={locked} testId="settings-parallel" />
        <label>Chunk size (tokens)</label>
        <input type="number" min={200} max={20000} step={100} style={{ width: 100 }} disabled={locked} value={s.maxChunkTokens} onChange={(e) => set({ maxChunkTokens: Number(e.target.value) })} data-testid="settings-chunk" />
      </div>
      <div className="dim small">A new chunk size applies only while every chunk is still pending. Once chunks have been made and some are done, the old size stays.</div>
      <div className="row">
        <button className="primary" disabled={locked || !dirty || saving} onClick={() => void save()} data-testid="settings-save">{saving ? 'Saving...' : 'Save settings'}</button>
        {dirty && !locked && <button onClick={() => setDraft({})}>Discard changes</button>}
      </div>
    </div>
  )
}
