import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import type { Command, EngineEvent } from '../shared/protocol'

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

/** Main-process end of the engine link: sends commands with an id, resolves them from `reply` events, passes every other event on. */
export class EngineClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Set<(e: EngineEvent) => void>()
  private exited = false
  private tail = ''
  private readonly exitHandlers = new Set<(info: { code: number; ready: boolean; stderr: string }) => void>()
  /** True once the engine has sent engine.ready. */
  ready = false

  constructor(private readonly child: UtilityProcess) {
    child.on('message', (data: unknown) => {
      const event = data as EngineEvent
      if (event.type === 'engine.ready') this.ready = true
      if (event.type === 'reply') {
        const p = this.pending.get(event.id)
        if (!p) return
        this.pending.delete(event.id)
        if (event.ok) p.resolve(event.result)
        else p.reject(new Error(event.error))
        return
      }
      for (const h of this.handlers) h(event)
    })
    child.on('exit', (code) => {
      this.exited = true
      for (const p of this.pending.values()) p.reject(new Error('the engine process stopped'))
      this.pending.clear()
      for (const h of this.exitHandlers) h({ code, ready: this.ready, stderr: this.tail.trim() })
    })
  }

  /** Keeps the last 2000 characters of the engine's stderr, for the message when it fails to start. */
  addStderr(text: string): void {
    this.tail = (this.tail + text).slice(-2000)
  }

  /** Called when the engine process ends, with its exit code, whether it got ready and its last stderr text. */
  onExit(handler: (info: { code: number; ready: boolean; stderr: string }) => void): void {
    this.exitHandlers.add(handler)
  }

  request(command: Command): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('the engine process is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.postMessage({ id, command })
    })
  }

  onEvent(handler: (e: EngineEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.child.kill()
  }
}

/** Starts the engine (out/engine/index.js serve) as an Electron utilityProcess. */
export function startEngine(enginePath: string, args: string[]): EngineClient {
  const child = utilityProcess.fork(enginePath, ['serve', ...args], { serviceName: 'book-translator-engine', stdio: 'pipe' })
  const client = new EngineClient(child)
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
  child.stderr?.on('data', (d: Buffer) => {
    client.addStderr(d.toString())
    process.stderr.write(d)
  })
  child.on('spawn', () => console.log(`[main] engine started (pid ${child.pid}): ${enginePath}`))
  child.on('exit', (code) => console.log(`[main] engine exited with code ${code}`))
  return client
}
