import { contextBridge, ipcRenderer } from 'electron'
import type { BookTranslatorApi, EngineEvent } from '../shared/protocol'

const api: BookTranslatorApi = {
  on(handler) {
    const listener = (_e: unknown, event: EngineEvent) => handler(event)
    ipcRenderer.on('engine:event', listener)
    return () => {
      ipcRenderer.removeListener('engine:event', listener)
    }
  },
  request: (command) => ipcRenderer.invoke('engine:request', command) as never,
  pickFile: () => ipcRenderer.invoke('host:pickFile'),
  openPath: (rel) => ipcRenderer.invoke('host:openPath', rel),
  showInFolder: (file) => ipcRenderer.invoke('host:showInFolder', file)
}

contextBridge.exposeInMainWorld('bt', api)
