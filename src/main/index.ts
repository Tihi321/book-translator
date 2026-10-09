import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import path from 'node:path'
import { isRequest } from '../shared/protocol'
import type { Command, EngineEvent, EngineInfo } from '../shared/protocol'
import { startEngine } from './engineClient'
import type { EngineClient } from './engineClient'

const EVENT_CHANNEL = 'engine:event'

let win: BrowserWindow | null = null
let engine: EngineClient | null = null
let info: EngineInfo | null = null
let blockerId: number | null = null
const running = new Set<string>()

// BOOK_TRANSLATOR_NO_WINDOW=1 runs the engine without the window (scripted checks).
const noWindow = process.env.BOOK_TRANSLATOR_NO_WINDOW === '1'

function forwardedEngineArgs(): string[] {
  const i = process.argv.findIndex((a) => a === '--data')
  const value = i >= 0 ? process.argv[i + 1] : undefined
  const args = value ? ['--data', value] : []
  // The engine cannot find `seed/` from the built app, so a packaged app hands it the copy in resources.
  if (app.isPackaged) args.push('--seed', path.join(process.resourcesPath, 'seed'))
  return args
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1360,
    height: 880,
    title: 'Book Translator',
    backgroundColor: '#12161e',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(path.join(__dirname, '../renderer/index.html'))
  return w
}

/** The computer stays awake while a translation runs. */
function updatePowerBlocker(): void {
  if (running.size > 0 && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  else if (running.size === 0 && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

function trackRunning(event: EngineEvent): void {
  if (event.type === 'project.updated') {
    if (event.project.status === 'translating' || event.project.status === 'glossary') running.add(event.project.id)
    else running.delete(event.project.id)
    updatePowerBlocker()
  } else if (event.type === 'project.deleted') {
    running.delete(event.projectId)
    updatePowerBlocker()
  }
}

/** A path inside the data folder, or null. */
function insideData(p: unknown, absolute = false): string | null {
  if (!info || typeof p !== 'string') return null
  const root = path.resolve(info.dataDir)
  const full = absolute ? path.resolve(p) : path.resolve(root, p)
  const back = path.relative(root, full)
  return back.startsWith('..') || path.isAbsolute(back) ? null : full
}

async function engineInfo(): Promise<EngineInfo> {
  if (!info) info = (await engine!.request({ type: 'getInfo' })) as EngineInfo
  return info
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app.whenReady().then(() => {
    engine = startEngine(path.join(__dirname, '../engine/index.js'), forwardedEngineArgs())
    engine.onEvent((event) => {
      if (event.type === 'engine.ready') info = event.info
      trackRunning(event)
      if (win && !win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, event)
    })

    ipcMain.handle('engine:request', (_e, command: unknown) => {
      if (!isRequest({ id: 0, command })) throw new Error('bad command')
      return engine!.request(command as Command)
    })
    ipcMain.handle('host:pickFile', async () => {
      // scripted checks cannot drive the native dialog
      if (process.env.BOOK_TRANSLATOR_PICK_FILE) return process.env.BOOK_TRANSLATOR_PICK_FILE
      const exts = (await engineInfo()).extensions.map((e) => e.replace(/^\./, ''))
      const options = {
        title: 'Choose a document to translate',
        properties: ['openFile' as const],
        filters: [{ name: 'Documents', extensions: exts }, { name: 'All files', extensions: ['*'] }]
      }
      const res = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return res.canceled ? null : (res.filePaths[0] ?? null)
    })
    ipcMain.handle('host:openPath', async (_e, rel: unknown) => {
      await engineInfo()
      const full = insideData(rel)
      return full ? (await shell.openPath(full)) === '' : false
    })
    ipcMain.handle('host:showInFolder', async (_e, file: unknown) => {
      await engineInfo()
      const full = insideData(file, true)
      if (!full) return false
      shell.showItemInFolder(full)
      return true
    })

    if (!noWindow) win = createWindow()

    app.on('before-quit', () => {
      // In-progress chunks go back to pending when the project is started again (every chunk file is written atomically).
      engine?.close()
      if (blockerId !== null) powerSaveBlocker.stop(blockerId)
    })
    app.on('activate', () => {
      if (!noWindow && BrowserWindow.getAllWindows().length === 0) win = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!noWindow) app.quit()
  })
}
