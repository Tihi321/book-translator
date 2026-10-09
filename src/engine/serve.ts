import { CommandDispatcher, serveEngine } from './dispatcher'
import { scriptDevMock } from './models/devMock'
import { MockProvider } from './models/mock'
import { ModelRegistry } from './models/registry'
import { EngineService } from './service'
import { argValue, initDataFolder, resolveDataDir } from './store/dataFolder'
import { getParentPort, IpcTransport, ParentPortTransport } from './transport'
import type { EngineTransport } from '../shared/protocol'

function pickTransport(): EngineTransport {
  const port = getParentPort()
  if (port) return new ParentPortTransport(port)
  if (process.send) return new IpcTransport()
  throw new Error('serve needs an Electron utilityProcess or a Node child process with an IPC channel')
}

/** `engine serve`: the app's engine. Answers commands from the main process and sends events back. */
export async function serve(argv: string[]): Promise<void> {
  const transport = pickTransport()
  const dataDir = resolveDataDir({ argv })
  await initDataFolder(dataDir, argValue(argv, 'seed'))
  const showMock = process.env.BOOK_TRANSLATOR_MOCK === '1'
  // BOOK_TRANSLATOR_MOCK_DELAY (ms per streamed piece) slows the mock models down, to watch a run in the UI
  const delay = Number(process.env.BOOK_TRANSLATOR_MOCK_DELAY) || undefined
  const registry = new ModelRegistry(dataDir, delay ? { mock: new MockProvider('mock', { chunkDelayMs: delay, chunks: 10 }) } : {})
  await registry.load()
  if (showMock) scriptDevMock(registry.mock)
  const service = new EngineService({ dataDir, registry, emit: (ev) => transport.send(ev) })
  const dispatcher = new CommandDispatcher({ service, emit: (ev) => transport.send(ev), showMock })
  serveEngine(transport, dispatcher)
  transport.send({ type: 'engine.ready', info: dispatcher.info() })
  process.stderr.write(`[engine] serving, data folder ${dataDir}\n`)
  // local servers are asked in the background, the models list follows as an event
  void dispatcher.discover().then((models) => transport.send({ type: 'models', models }))
  // the process stays alive while the message port / IPC channel is open
}
