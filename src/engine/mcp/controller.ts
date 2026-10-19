import type { EngineBus } from '../bus'
import type { CommandDispatcher } from '../dispatcher'
import type { KeyResolver } from '../models/keys'
import type { EngineService } from '../service'
import { startMcpHttp } from './http'
import type { McpHttp } from './http'
import { createMcpServer } from './server'
import { getOrCreateMcpToken } from './token'
import type { McpStatus } from '../../shared/protocol'

export interface McpControllerOptions {
  dispatcher: CommandDispatcher
  service: EngineService
  bus: EngineBus
  /** Always on, whatever config/defaults.json says (`serve --mcp`, `headless`). */
  force?: boolean
  /** Replaces the port of config/defaults.json (`headless --port`). */
  port?: number
  keys?: KeyResolver
  storeKey?: (name: string, value: string) => void
}

/** Starts, stops and restarts the MCP endpoint to follow `mcp` of config/defaults.json, and reports its state. */
export class McpController {
  private http?: McpHttp
  private token?: string
  private enabled = false
  private error?: string
  /** Applies run one after the other: a quick toggle must not leave two servers. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: McpControllerOptions) {}

  status(): McpStatus {
    return {
      enabled: this.enabled,
      running: this.http !== undefined,
      ...(this.http ? { url: this.http.url } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.enabled && this.token ? { token: this.token } : {})
    }
  }

  /** Brings the server in line with the settings. A busy port or a missing credential store is reported in `status().error`, not thrown. */
  apply(cfg: { enabled: boolean; port: number }): Promise<void> {
    this.queue = this.queue.then(() => this.applyNow(cfg))
    return this.queue
  }

  private async applyNow(cfg: { enabled: boolean; port: number }): Promise<void> {
    await this.closeHttp()
    this.error = undefined
    this.enabled = this.opts.force === true || cfg.enabled
    if (!this.enabled) return
    const port = this.opts.port ?? cfg.port
    try {
      this.token ??= getOrCreateMcpToken(this.opts.keys, this.opts.storeKey)
      const { dispatcher, service, bus } = this.opts
      this.http = await startMcpHttp({ port, token: this.token, factory: () => createMcpServer(dispatcher, service, bus) })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      this.error = e.code === 'EADDRINUSE' ? `port ${port} is already in use` : e.message
    }
  }

  private async closeHttp(): Promise<void> {
    const http = this.http
    this.http = undefined
    await http?.close()
  }

  stop(): Promise<void> {
    this.queue = this.queue.then(() => this.closeHttp())
    return this.queue
  }
}
