import { applyModelDefaults, loadDefaults } from './config'
import { EngineBus } from './bus'
import { CommandDispatcher, serveEngine, SLOT_SYNC_MS } from './dispatcher'
import type { DispatcherOptions } from './dispatcher'
import { McpController } from './mcp/controller'
import { scriptDevMock } from './models/devMock'
import { MockProvider } from './models/mock'
import { ModelRegistry } from './models/registry'
import { EngineService } from './service'
import { argValue, initDataFolder, resolveDataDir } from './store/dataFolder'
import { acquireDataLock, releaseOnExit } from './store/lock'
import { getParentPort, IpcTransport, ParentPortTransport } from './transport'
import type { EngineEvent, EngineTransport } from '../shared/protocol'

function pickTransport(): EngineTransport {
  const port = getParentPort()
  if (port) return new ParentPortTransport(port)
  if (process.send) return new IpcTransport()
  throw new Error('serve needs an Electron utilityProcess or a Node child process with an IPC channel')
}

export interface BootOptions {
  argv: string[]
  /** Where the events go besides the bus (the transport of `serve`). */
  send?: (ev: EngineEvent) => void
  /** The state of the MCP server, for `getMcpStatus`. */
  mcpStatus?: DispatcherOptions['mcpStatus']
  /** Called after `setDefaults` saved the file. */
  onDefaultsSaved?: DispatcherOptions['onDefaultsSaved']
}

export interface BootedEngine {
  dataDir: string
  service: EngineService
  dispatcher: CommandDispatcher
  bus: EngineBus
  /** Ends the slot timer and removes the data folder lock. */
  stop: () => Promise<void>
}

/**
 * Starts the engine in this process: locks the data folder (one engine per folder), seeds it, loads the models, marks interrupted
 * projects as paused and starts the slot timer. Throws when another engine uses the folder. Used by `serve` and `headless`.
 */
export async function bootEngine(opts: BootOptions): Promise<BootedEngine> {
  const { argv } = opts
  const dataDir = resolveDataDir({ argv })
  const lock = await acquireDataLock(dataDir)
  releaseOnExit(lock)
  try {
    await initDataFolder(dataDir, argValue(argv, 'seed'))
    const showMock = process.env.BOOK_TRANSLATOR_MOCK === '1'
    // BOOK_TRANSLATOR_MOCK_DELAY (ms per streamed piece) slows the mock models down, to watch a run in the UI
    const delay = Number(process.env.BOOK_TRANSLATOR_MOCK_DELAY) || undefined
    const registry = new ModelRegistry(dataDir, delay ? { mock: new MockProvider('mock', { chunkDelayMs: delay, chunks: 10 }) } : {})
    await applyModelDefaults(registry, dataDir)
    await registry.load()
    if (showMock) scriptDevMock(registry.mock)
    const bus = new EngineBus()
    const emit = (ev: EngineEvent) => {
      opts.send?.(ev)
      bus.emit(ev)
    }
    const service = new EngineService({ dataDir, registry, emit })
    await service.recoverInterrupted()
    const dispatcher = new CommandDispatcher({ service, emit, showMock, mcpStatus: opts.mcpStatus, onDefaultsSaved: opts.onDefaultsSaved })
    // `concurrency: auto` servers (Strata, LM Studio) report their slot count: asked now and every few seconds, so starting a
    // "4 at once" or a "one at a time" script needs no change in providers.md
    void dispatcher.syncSlots()
    const slotTimer = setInterval(() => void dispatcher.syncSlots(), SLOT_SYNC_MS)
    slotTimer.unref?.()
    // the timer ends with the process, or with the IPC channel of a Node child
    const stopTimer = () => clearInterval(slotTimer)
    process.once('exit', stopTimer)
    process.once('disconnect', stopTimer)
    return {
      dataDir,
      service,
      dispatcher,
      bus,
      stop: async () => {
        stopTimer()
        await lock.release()
      }
    }
  } catch (err) {
    await lock.release()
    throw err
  }
}

/** `engine serve`: the app's engine. Answers commands from the main process and sends events back. */
export async function serve(argv: string[]): Promise<void> {
  const transport = pickTransport()
  // MCP follows `mcp` in config/defaults.json; `--mcp` turns it on for this run. The token is never printed here: the Settings card shows it.
  const ctl: { mcp?: McpController } = {}
  const engine = await bootEngine({
    argv,
    send: (ev) => transport.send(ev),
    mcpStatus: () => ctl.mcp?.status() ?? { enabled: false, running: false },
    onDefaultsSaved: async (before, after) => {
      if (before.mcp.enabled !== after.mcp.enabled || before.mcp.port !== after.mcp.port) await ctl.mcp?.apply(after.mcp)
    }
  })
  const { dispatcher, service, bus, dataDir } = engine
  const mcp = new McpController({ dispatcher, service, bus, force: argv.includes('--mcp') })
  ctl.mcp = mcp
  serveEngine(transport, dispatcher)
  transport.send({ type: 'engine.ready', info: dispatcher.info() })
  process.stderr.write(`[engine] serving, data folder ${dataDir}\n`)
  // local servers are asked in the background, the models list follows as an event
  void dispatcher.discover().then((models) => transport.send({ type: 'models', models }))
  await mcp.apply((await loadDefaults(dataDir)).mcp)
  const st = mcp.status()
  if (st.running) process.stderr.write(`[engine] MCP server at ${st.url}\n`)
  else if (st.error) process.stderr.write(`[engine] MCP server not started: ${st.error}\n`)
  // the process stays alive while the message port / IPC channel is open
}

/** One short stderr line for the events that matter in a terminal: logs, errors and status changes. */
function describeEvent(ev: EngineEvent, lastStatus: Map<string, string>): string | undefined {
  if (ev.type === 'log') return `[${ev.level}]${ev.projectId ? ` ${ev.projectId}:` : ''} ${ev.message}`
  if (ev.type === 'error') return `[error]${ev.projectId ? ` ${ev.projectId}:` : ''} ${ev.message}`
  if (ev.type === 'project.updated') {
    const p = ev.project
    if (lastStatus.get(p.id) === p.status) return undefined
    lastStatus.set(p.id, p.status)
    return `[project] ${p.id}: ${p.status} (${p.done}/${p.chunks} chunks)`
  }
  return undefined
}

/**
 * `engine headless`: the engine with no window. MCP is always on; the URL and the token are printed once to stderr, events are logged to
 * stderr, and Ctrl+C pauses the running projects and ends the process (no process.exit: the sockets close and Node ends by itself).
 */
export async function headless(argv: string[]): Promise<void> {
  const portArg = argValue(argv, 'port')
  const port = portArg === undefined ? undefined : Number(portArg)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error(`--port must be a number from 0 to 65535 (got ${portArg})`)
  const ctl: { mcp?: McpController } = {}
  const engine = await bootEngine({ argv, mcpStatus: () => ctl.mcp?.status() ?? { enabled: false, running: false } })
  const { dispatcher, service, bus, dataDir } = engine
  const mcp = new McpController({ dispatcher, service, bus, force: true, port })
  ctl.mcp = mcp
  const lastStatus = new Map<string, string>()
  bus.on((ev) => {
    const line = describeEvent(ev, lastStatus)
    if (line) process.stderr.write(line + '\n')
  })
  process.stderr.write(`[headless] data folder ${dataDir}\n`)
  await mcp.apply((await loadDefaults(dataDir)).mcp)
  const st = mcp.status()
  if (!st.running) {
    await engine.stop()
    throw new Error(`the MCP server did not start: ${st.error ?? 'unknown error'}`)
  }
  process.stderr.write(`[headless] MCP server at ${st.url}\n[headless] token (shown once): ${st.token}\n[headless] Ctrl+C pauses running projects and stops\n`)
  void dispatcher.discover()
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    process.stderr.write('\n[headless] stopping: pausing running projects\n')
    try {
      for (const p of await service.listProjects()) if (service.isRunning(p.id)) await service.pause(p.id)
      await mcp.stop()
    } finally {
      await engine.stop()
    }
    // nothing keeps the process alive now (the slot timer is stopped, the server is closed): it ends by itself
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
  // the open server socket keeps the process alive until `shutdown`
}
