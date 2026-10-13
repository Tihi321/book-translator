import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isRequest } from '../shared/protocol'
import type { BookFile, Command, EngineEvent, EngineInfo, FolderListing } from '../shared/protocol'
import { startEngine } from './engineClient'
import type { EngineClient } from './engineClient'

const EVENT_CHANNEL = 'engine:event'

let win: BrowserWindow | null = null
let engine: EngineClient | null = null
let info: EngineInfo | null = null
let blockerId: number | null = null
const running = new Set<string>()
/** Files the user picked for the reader (resolved paths). */
const granted = new Set<string>()
const BOOK_EXTS = ['.epub', '.pdf', '.txt', '.md', '.markdown']
const BOOK_MAX = 300 * 1024 * 1024

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
  // book content (Markdown links and the like) never takes the window away from the app
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
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

/** The documents the engine can read in a folder: top level only, in natural name order (chapter2 before chapter10). */
async function listDocuments(dir: unknown): Promise<FolderListing> {
  if (typeof dir !== 'string' || !dir) throw new Error('no folder')
  const folder = path.resolve(dir)
  if (!(await stat(folder)).isDirectory()) throw new Error('Not a folder')
  const exts = new Set((await engineInfo()).extensions.map((e) => e.toLowerCase()))
  const entries = await readdir(folder, { withFileTypes: true })
  const names = entries.filter((e) => e.isFile() && exts.has(path.extname(e.name).toLowerCase())).map((e) => e.name)
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return { folder, files: names.map((n) => path.join(folder, n)) }
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
    ipcMain.handle('host:pickFolder', async () => {
      if (process.env.BOOK_TRANSLATOR_PICK_FOLDER) return listDocuments(process.env.BOOK_TRANSLATOR_PICK_FOLDER)
      const options = { title: 'Choose a folder of documents to translate', properties: ['openDirectory' as const] }
      const res = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return res.canceled || !res.filePaths[0] ? null : listDocuments(res.filePaths[0])
    })
    ipcMain.handle('host:listFolder', (_e, dir: unknown) => listDocuments(dir))
    ipcMain.handle('host:pickBook', async () => {
      let picked: string | null
      if (process.env.BOOK_TRANSLATOR_PICK_FILE) picked = process.env.BOOK_TRANSLATOR_PICK_FILE
      else {
        const options = {
          title: 'Open a book',
          properties: ['openFile' as const],
          filters: [{ name: 'Books', extensions: BOOK_EXTS.map((e) => e.slice(1)) }]
        }
        const res = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        picked = res.canceled ? null : (res.filePaths[0] ?? null)
      }
      if (picked) granted.add(path.resolve(picked))
      return picked
    })
    ipcMain.handle('host:readBook', async (_e, target: unknown): Promise<BookFile> => {
      const t = target as { path?: unknown; projectId?: unknown } | null
      await engineInfo()
      let file: string | null = null
      if (t && typeof t.projectId === 'string') {
        const res = (await engine!.request({ type: 'getProject', projectId: t.projectId })) as { project: { sourcePath: string } }
        file = path.resolve(res.project.sourcePath)
      } else if (t && typeof t.path === 'string') {
        const full = path.resolve(t.path)
        if (granted.has(full) || insideData(full, true)) file = full
      }
      if (!file) throw new Error('This file cannot be opened')
      const ext = path.extname(file).toLowerCase()
      if (!BOOK_EXTS.includes(ext)) throw new Error(`Unsupported file type: ${ext || 'none'}`)
      const st = await stat(file)
      if (!st.isFile()) throw new Error('Not a file')
      if (st.size > BOOK_MAX) throw new Error('The file is larger than 300 MB')
      return { name: path.basename(file), ext, bytes: await readFile(file) }
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
