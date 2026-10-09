import { useEffect } from 'react'
import { connectEngine, useStore } from './store/store'
import { NewProject } from './ui/NewProject'
import { ProjectsList } from './ui/ProjectsList'
import { ProjectView } from './ui/ProjectView'
import { Settings } from './ui/Settings'

export function App() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  const mock = useStore((s) => s.info?.mock)

  useEffect(() => {
    const off = connectEngine()
    useStore.getState().init().catch((err: Error) => useStore.getState().toast(`Could not reach the engine: ${err.message}`))
    return off
  }, [])

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">BOOK TRANSLATOR</span>
        <button className={view.name === 'list' || view.name === 'project' ? 'active' : ''} onClick={() => setView({ name: 'list' })}>Translations</button>
        <button className={view.name === 'new' ? 'active' : ''} onClick={() => setView({ name: 'new' })}>New translation</button>
        <span className="spacer" />
        {mock && <span className="badge warn">mock models on</span>}
        <button className={view.name === 'settings' ? 'active' : ''} onClick={() => setView({ name: 'settings' })}>Settings</button>
      </div>
      {view.name === 'list' && <ProjectsList />}
      {view.name === 'new' && <NewProject />}
      {view.name === 'project' && <ProjectView id={view.id} />}
      {view.name === 'settings' && <Settings />}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  )
}
