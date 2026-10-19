import { EventEmitter } from 'node:events'
import type { EngineEvent } from '../shared/protocol'

/** Every engine event, for listeners inside the engine process (the MCP tools wait on it, headless mode logs it). */
export class EngineBus {
  private readonly ee = new EventEmitter()

  constructor() {
    // one listener per waiting MCP call
    this.ee.setMaxListeners(100)
  }

  emit(ev: EngineEvent): void {
    this.ee.emit('event', ev)
  }

  /** Listens to every event. Returns the function that stops listening. */
  on(handler: (ev: EngineEvent) => void): () => void {
    this.ee.on('event', handler)
    return () => this.ee.off('event', handler)
  }
}
