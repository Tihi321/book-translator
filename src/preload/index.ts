import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  pickFolder: () => ipcRenderer.invoke('host:pickFolder'),
  listFolder: (dir) => ipcRenderer.invoke('host:listFolder', dir),
  // File.path is gone since Electron 32: the preload asks webUtils for a dropped file's path
  pathForFile: (file) => webUtils.getPathForFile(file),
  pickBook: () => ipcRenderer.invoke('host:pickBook'),
  readBook: (target) => ipcRenderer.invoke('host:readBook', target),
  openPath: (rel) => ipcRenderer.invoke('host:openPath', rel),
  showInFolder: (file) => ipcRenderer.invoke('host:showInFolder', file)
}

contextBridge.exposeInMainWorld('bt', api)
