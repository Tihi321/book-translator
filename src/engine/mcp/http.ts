import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface McpHttpOptions {
  /** 0 picks a free port. */
  port: number
  token: string
  /** A new server for every request (the endpoint is stateless). */
  factory: () => McpServer
}

export interface McpHttp {
  url: string
  port: number
  close: () => Promise<void>
}

const MAX_BODY = 8 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * The MCP endpoint `http://127.0.0.1:<port>/mcp`: Streamable HTTP without sessions (a new transport and server per POST, plain JSON answers).
 * Only loopback Host and Origin values are accepted (403, against DNS rebinding) and every request needs `Authorization: Bearer <token>` (401).
 * GET and DELETE answer 405: there is no session or server-to-client stream.
 */
export async function startMcpHttp(opts: McpHttpOptions): Promise<McpHttp> {
  let boundPort = opts.port
  const hostOk = (host: string | undefined) => host !== undefined && [...LOOPBACK].some((h) => host === `${h}:${boundPort}` || (boundPort === 80 && host === h))
  const originOk = (origin: string | undefined) => {
    if (origin === undefined) return true
    try {
      const u = new URL(origin)
      return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname)
    } catch {
      return false
    }
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) return sendJson(res, 403, rpcError(-32000, 'Forbidden: bad Host or Origin'))
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
      if (!auth || !sameToken(auth[1]!.trim(), opts.token)) return sendJson(res, 401, rpcError(-32001, 'Unauthorized: send the token as "Authorization: Bearer <token>"'), { 'www-authenticate': 'Bearer' })
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') return sendJson(res, 404, rpcError(-32000, 'Not found: the endpoint is /mcp'))
      if (req.method !== 'POST') return sendJson(res, 405, rpcError(-32000, 'Method not allowed'), { allow: 'POST' })
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        return sendJson(res, 400, rpcError(-32700, 'Parse error'))
      }
      const mcp = opts.factory()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, err instanceof Error ? err.message : 'Internal error'))
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  boundPort = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
