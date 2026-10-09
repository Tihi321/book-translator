import { isRequest } from '../shared/protocol'
import type { EngineEvent, EngineTransport, Request } from '../shared/protocol'

/** The subset of Electron's `process.parentPort` (a MessagePortMain) that we use. */
interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  removeListener(event: 'message', listener: (e: { data: unknown }) => void): void
}

export function getParentPort(): ParentPort | undefined {
  return (process as unknown as { parentPort?: ParentPort }).parentPort
}

/** Engine end of the Electron utilityProcess link. */
export class ParentPortTransport implements EngineTransport {
  constructor(private readonly port: ParentPort) {}

  send(message: EngineEvent): void {
    this.port.postMessage(message)
  }

  onMessage(handler: (message: Request) => void): () => void {
    const listener = (e: { data: unknown }) => {
      if (isRequest(e.data)) handler(e.data)
    }
    this.port.on('message', listener)
    return () => this.port.removeListener('message', listener)
  }

  close(): void {
    // The port closes with the process.
  }
}

/** Engine end of a Node `child_process.fork` link (IPC channel), used by scripted checks without Electron. */
export class IpcTransport implements EngineTransport {
  send(message: EngineEvent): void {
    process.send?.(message)
  }

  onMessage(handler: (message: Request) => void): () => void {
    const listener = (m: unknown) => {
      if (isRequest(m)) handler(m)
    }
    process.on('message', listener)
    return () => process.removeListener('message', listener)
  }

  close(): void {
    process.disconnect?.()
  }
}
