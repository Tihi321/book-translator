import { promises as fs } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineBus } from '../src/engine/bus'
import { CommandDispatcher } from '../src/engine/dispatcher'
import { McpController } from '../src/engine/mcp/controller'
import { startMcpHttp } from '../src/engine/mcp/http'
import type { McpHttp } from '../src/engine/mcp/http'
import { createMcpServer } from '../src/engine/mcp/server'
import { getOrCreateMcpToken, MCP_TOKEN_NAME } from '../src/engine/mcp/token'
import { MODEL, QA_MODEL, rig, segsIn } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

const TOKEN = 'test-token'
const MODELS = { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] }
const NO_AGENTS = { glossary: false, proofreader: false, qa: false }

let r: Rig | undefined
let server: McpHttp | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close().catch(() => undefined)
  await server?.close()
  await r?.cleanup()
  r = server = client = undefined
})

async function setup() {
  const bus = new EngineBus()
  r = await rig({ onEvent: (e) => bus.emit(e) })
  const dispatcher = new CommandDispatcher({ service: r.service, emit: (e) => bus.emit(e), showMock: true, keys: () => undefined, storeKey: () => undefined })
  const svc = r.service
  server = await startMcpHttp({ port: 0, token: TOKEN, factory: () => createMcpServer(dispatcher, svc, bus) })
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }))
  client = c
  return { r, dispatcher, bus, c, url: server.url }
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }

/** Calls a tool and returns its first text as JSON (or the text when it isn't JSON). */
async function call<T = unknown>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await c.callTool({ name, arguments: args })) as ToolResult
  const t = res.content[0]!.text
  if (res.isError) throw new Error(t)
  try {
    return JSON.parse(t) as T
  } catch {
    return t as T
  }
}

function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (d: Buffer) => parts.push(d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } })
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

describe('MCP HTTP endpoint', () => {
  it('needs the bearer token (401), a loopback Host and Origin (403) and POST (405)', async () => {
    const { url } = await setup()
    const u = new URL(url)
    const host = `127.0.0.1:${u.port}`
    expect((await raw(url, { headers: { ...JSON_HEADERS, host }, body: INIT })).status).toBe(401)
    expect((await raw(url, { headers: { ...JSON_HEADERS, host, authorization: 'Bearer wrong' }, body: INIT })).status).toBe(401)
    expect((await raw(url, { headers: { ...JSON_HEADERS, host, authorization: 'Basic abc' }, body: INIT })).status).toBe(401)
    const good = await raw(url, { headers: { ...JSON_HEADERS, host, authorization: `Bearer ${TOKEN}` }, body: INIT })
    expect(good.status).toBe(200)
    expect(good.body).toContain('book-translator')
    expect((await raw(url, { headers: { ...JSON_HEADERS, host: 'evil.example.com', authorization: `Bearer ${TOKEN}` }, body: INIT })).status).toBe(403)
    expect((await raw(url, { headers: { ...JSON_HEADERS, host: 'evil.example.com:80' }, body: INIT })).status).toBe(403)
    expect((await raw(url, { headers: { ...JSON_HEADERS, host, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example.com' }, body: INIT })).status).toBe(403)
    expect((await raw(url, { headers: { ...JSON_HEADERS, host, authorization: `Bearer ${TOKEN}`, origin: `http://localhost:${u.port}` }, body: INIT })).status).toBe(200)
    expect((await raw(url, { method: 'GET', headers: { host, authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } })).status).toBe(405)
    expect((await raw(url, { method: 'DELETE', headers: { host, authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
    expect((await raw(url.replace('/mcp', '/other'), { headers: { ...JSON_HEADERS, host, authorization: `Bearer ${TOKEN}` }, body: INIT })).status).toBe(404)
    expect((await raw(url, { headers: { ...JSON_HEADERS, host, authorization: `Bearer ${TOKEN}` }, body: '{not json' })).status).toBe(400)
  })

  it('lists the tools and the prompt, and leaves out keys, providers and deleting', async () => {
    const { c } = await setup()
    const names = (await c.listTools()).tools.map((t) => t.name)
    for (const n of [
      'get_info', 'list_models', 'get_defaults', 'list_languages', 'list_projects', 'analyze_file', 'create_project', 'get_project', 'update_project_settings',
      'start_translation', 'pause_translation', 'cancel_translation', 'wait_for_progress', 'get_chunk', 'edit_chunk', 'retry_chunk', 'update_glossary', 'set_brief', 'export_project',
      'prepare_chunks', 'get_translation_task', 'submit_translation'
    ]) expect(names).toContain(n)
    expect(names.filter((n) => /secret|provider|limit|delete|key|detect|add_model|show_models/.test(n))).toEqual([])
    const prompts = (await c.listPrompts()).prompts
    expect(prompts.map((p) => p.name)).toEqual(['translate_book_yourself'])
    const prompt = await c.getPrompt({ name: 'translate_book_yourself', arguments: { file: 'C:/books/a.epub', targetLanguage: 'Croatian' } })
    const msg = prompt.messages[0]!.content as { text: string }
    expect(msg.text).toContain('C:/books/a.epub')
    expect(msg.text).toContain('Croatian')
    expect(msg.text).toContain('submit_translation')
    expect(c.getInstructions()).toContain('Operator')
  })

  it('answers a failing tool with isError and the engine message, and checks the arguments', async () => {
    const { c } = await setup()
    const res = (await c.callTool({ name: 'get_project', arguments: { projectId: 'missing' } })) as ToolResult
    expect(res.isError).toBe(true)
    expect(res.content[0]!.text).toMatch(/ENOENT|missing/)
    const bad = (await c.callTool({ name: 'wait_for_progress', arguments: { projectId: 'x', timeoutSec: 61 } })) as ToolResult
    expect(bad.isError).toBe(true)
    const noFile = (await c.callTool({ name: 'create_project', arguments: { sourcePath: path.join(r!.dir, 'nope.md'), targetLanguage: 'hr' } })) as ToolResult
    expect(noFile.isError).toBe(true)
  })

  it('info tools answer: models are trimmed and the defaults carry no language list', async () => {
    const { c } = await setup()
    const models = await call<{ ref: string; available: boolean; context: number }[]>(c, 'list_models')
    const mock = models.find((m) => m.ref === MODEL)!
    expect(mock).toMatchObject({ available: true })
    expect(Object.keys(mock).sort()).toEqual(['available', 'context', 'local', 'priceInPer1M', 'priceOutPer1M', 'ref'])
    const defaults = await call<Record<string, unknown>>(c, 'get_defaults')
    expect(defaults).not.toHaveProperty('languages')
    expect(defaults).toHaveProperty('agentModels')
    expect((await call<{ code: string }[]>(c, 'list_languages')).some((l) => l.code === 'hr')).toBe(true)
    expect(await call<{ dataDir: string }>(c, 'get_info')).toMatchObject({ dataDir: r!.dir })
    const analysis = await call<{ file: { format: string }; estimate: { chunks: number } }>(c, 'analyze_file', { sourcePath: r!.file, targetLanguage: 'Croatian' })
    expect(analysis.file.format).toBe('md')
    expect(await call<unknown[]>(c, 'list_projects')).toEqual([])
  })
})

describe('MCP operator flow (the app models translate)', () => {
  it('create_project -> start_translation -> wait_for_progress until done -> export_project', async () => {
    const { r, c } = await setup()
    const project = await call<{ id: string; chunks: number }>(c, 'create_project', { sourcePath: r.file, targetLanguage: 'Croatian', sourceLanguage: 'English', agentModels: MODELS, enabledAgents: NO_AGENTS, maxChunkTokens: 100 })
    expect(project.id).toBeTruthy()
    // a settings change while stopped
    const detail0 = await call<{ project: { settings: { maxChunkTokens: number; enabled: Record<string, boolean> } } }>(c, 'update_project_settings', { projectId: project.id, maxChunkTokens: 120 })
    expect(detail0.project.settings).toMatchObject({ maxChunkTokens: 120, enabled: NO_AGENTS })
    await call(c, 'update_project_settings', { projectId: project.id, maxChunkTokens: 100 })

    // not running yet: wait_for_progress answers at once
    const idle = await call<{ status: string; running: boolean; timedOut: boolean }>(c, 'wait_for_progress', { projectId: project.id, timeoutSec: 5 })
    expect(idle).toMatchObject({ running: false, timedOut: false, status: 'created' })

    expect(await call(c, 'start_translation', { projectId: project.id })).toMatchObject({ started: true })
    let last: { status: string; done: number; total: number; running: boolean } | undefined
    for (let i = 0; i < 60; i++) {
      last = await call(c, 'wait_for_progress', { projectId: project.id, timeoutSec: 5 })
      if (!last!.running) break
    }
    expect(last).toMatchObject({ status: 'done', running: false })
    expect(last!.done).toBe(last!.total)
    expect(last!.total).toBeGreaterThan(3)

    const detail = await call<{ chunks: { index: number; state: string }[]; log: string }>(c, 'get_project', { projectId: project.id })
    expect(detail.chunks.every((x) => x.state === 'done')).toBe(true)
    expect(detail.log.split('\n').length).toBeLessThanOrEqual(40)
    const chunk = await call<{ final: Record<string, string>; model: string }>(c, 'get_chunk', { projectId: project.id, index: 1 })
    expect(Object.values(chunk.final)[0]).toContain('[hr] ')
    const edited = await call<{ edited: boolean; final: Record<string, string> }>(c, 'edit_chunk', { projectId: project.id, index: 1, final: { b1: 'Testna knjiga' } })
    expect(edited).toMatchObject({ edited: true, final: { b1: 'Testna knjiga' } })

    const out = await call<{ path: string }>(c, 'export_project', { projectId: project.id })
    const text = await fs.readFile(out.path, 'utf8')
    expect(text).toContain('Testna knjiga')
    expect(text).toContain('[hr] Paragraph 1 of chapter 2')
    // events of the run reached the bus-driven UI path too
    expect(r.events.some((e) => e.type === 'project.updated' && e.project.status === 'done')).toBe(true)
  })

  it('get_project keeps only the last 40 lines of the log', async () => {
    const { r, c } = await setup()
    const p = await call<{ id: string }>(c, 'create_project', { sourcePath: r.file, targetLanguage: 'hr', agentModels: MODELS, enabledAgents: NO_AGENTS })
    for (let i = 0; i < 100; i++) await r.service.store.log(p.id, `line ${i}`)
    const detail = await call<{ log: string }>(c, 'get_project', { projectId: p.id })
    const lines = detail.log.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(40)
    expect(lines[lines.length - 1]).toContain('line 99')
  })

  it('wait_for_progress ends at the timeout while a chunk is slow, then reports it', async () => {
    const { r, c } = await setup()
    r.mock.on({ role: 'translator' }, async (req) => {
      await new Promise((res) => setTimeout(res, 600))
      return segsIn(req.messages[req.messages.length - 1]!.content).map((s) => `<seg id="${s.id}">${s.text}</seg>`).join('\n')
    })
    const p = await call<{ id: string }>(c, 'create_project', { sourcePath: r.file, targetLanguage: 'hr', agentModels: MODELS, enabledAgents: NO_AGENTS, maxChunkTokens: 100 })
    await call(c, 'start_translation', { projectId: p.id })
    const t0 = Date.now()
    const waited = await call<{ timedOut: boolean; running: boolean }>(c, 'wait_for_progress', { projectId: p.id, timeoutSec: 1 })
    expect(waited).toMatchObject({ running: true })
    expect(Date.now() - t0).toBeLessThan(5000)
    await call(c, 'pause_translation', { projectId: p.id })
    const after = await call<{ status: string; running: boolean }>(c, 'wait_for_progress', { projectId: p.id })
    expect(after).toMatchObject({ status: 'paused', running: false })
  })
})

describe('MCP translator flow (the outside LLM translates)', () => {
  it('create_project (agents off) -> prepare_chunks -> get_translation_task / submit_translation loop -> export_project, with no model call', async () => {
    const { r, c } = await setup()
    const p = await call<{ id: string }>(c, 'create_project', { sourcePath: r.file, targetLanguage: 'Croatian', sourceLanguage: 'English', agentModels: { translator: [] }, enabledAgents: NO_AGENTS, maxChunkTokens: 100 })
    const prepared = await call<{ chunks: number; budget: number; pending: number }>(c, 'prepare_chunks', { projectId: p.id })
    expect(prepared.chunks).toBeGreaterThan(3)
    expect(prepared.pending).toBe(prepared.chunks)
    await call(c, 'update_glossary', { projectId: p.id, entries: [{ source: 'Alice', target: 'Alisa', type: 'person', gender: 'f' }] })
    await call(c, 'set_brief', { projectId: p.id, brief: 'Genre: fiction' })

    let submitted = 0
    let sawGlossary = false
    for (let i = 0; i < prepared.chunks + 5; i++) {
      const res = (await c.callTool({ name: 'get_translation_task', arguments: { projectId: p.id } })) as ToolResult
      expect(res.isError).toBeFalsy()
      const meta = JSON.parse(res.content[0]!.text) as { done?: boolean; index?: number; segmentIds?: string[]; remaining?: number }
      if (meta.done) {
        expect(meta.remaining).toBe(0)
        break
      }
      const system = res.content[1]!.text
      const user = res.content[2]!.text
      expect(system).toMatch(/^\[system\]/)
      expect(system).toContain('Genre: fiction')
      expect(user).toMatch(/^\[user\]/)
      if (user.includes('Alisa')) sawGlossary = true
      const segs = segsIn(user)
      expect(segs.map((s) => s.id)).toEqual(meta.segmentIds)
      if (submitted === 0) {
        // a wrong submission is a normal answer with the problems, and nothing is saved
        const wrong = await call<{ ok: boolean; problems: string[] }>(c, 'submit_translation', { projectId: p.id, index: meta.index, reply: '<seg id="nope">x</seg>' })
        expect(wrong.ok).toBe(false)
        expect(wrong.problems.join(' ')).toMatch(/missing or empty segments/)
      }
      const reply = segs.map((s) => `<seg id="${s.id}">[hr] ${s.text}</seg>`).join('\n')
      const ok = await call<{ ok: boolean; remaining: number }>(c, 'submit_translation', { projectId: p.id, index: meta.index, reply })
      expect(ok.ok).toBe(true)
      submitted++
    }
    expect(submitted).toBe(prepared.chunks)
    expect(sawGlossary).toBe(true)
    expect((await call<{ project: { status: string } }>(c, 'get_project', { projectId: p.id })).project.status).toBe('done')
    const out = await call<{ path: string }>(c, 'export_project', { projectId: p.id })
    const text = await fs.readFile(out.path, 'utf8')
    expect(text).toContain('[hr] Paragraph 2 of chapter 1')
    expect(text).not.toContain('\nParagraph 2 of chapter 1')
    expect(r.mock.calls).toHaveLength(0)
  })

  it('submit_translation can use a segments map and reports an unknown project as an error', async () => {
    const { r, c } = await setup()
    const p = await call<{ id: string }>(c, 'create_project', { sourcePath: r.file, targetLanguage: 'hr', agentModels: { translator: [] }, enabledAgents: NO_AGENTS, maxChunkTokens: 100 })
    await call(c, 'prepare_chunks', { projectId: p.id })
    const res = (await c.callTool({ name: 'get_translation_task', arguments: { projectId: p.id } })) as ToolResult
    const meta = JSON.parse(res.content[0]!.text) as { index: number; segmentIds: string[] }
    const ok = await call<{ ok: boolean }>(c, 'submit_translation', { projectId: p.id, index: meta.index, segments: Object.fromEntries(meta.segmentIds.map((id) => [id, `[hr] ${id}`])), model: 'claude/sonnet' })
    expect(ok.ok).toBe(true)
    expect((await call<{ model: string }>(c, 'get_chunk', { projectId: p.id, index: meta.index })).model).toBe('claude/sonnet')
    const bad = (await c.callTool({ name: 'submit_translation', arguments: { projectId: 'missing', index: 1, reply: 'x' } })) as ToolResult
    expect(bad.isError).toBe(true)
  })
})

describe('MCP token and controller', () => {
  it('creates a token once, stores it, and lets the environment variable win', () => {
    const stored: Record<string, string> = {}
    const keys = (n: string) => stored[n]
    const a = getOrCreateMcpToken(keys, (n, v) => void (stored[n] = v))
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(stored[MCP_TOKEN_NAME]).toBe(a)
    expect(getOrCreateMcpToken(keys, () => { throw new Error('must not store again') })).toBe(a)
    // no credential store: a token for this run
    expect(getOrCreateMcpToken(() => undefined, () => { throw new Error('no store') }).length).toBeGreaterThanOrEqual(32)
  })

  it('the controller follows the settings: off, on, port change, busy port', async () => {
    const bus = new EngineBus()
    r = await rig({ onEvent: (e) => bus.emit(e) })
    const stored: Record<string, string> = {}
    const dispatcher = new CommandDispatcher({ service: r.service, emit: (e) => bus.emit(e) })
    const mcp = new McpController({ dispatcher, service: r.service, bus, keys: (n) => stored[n], storeKey: (n, v) => void (stored[n] = v) })
    expect(mcp.status()).toEqual({ enabled: false, running: false })
    await mcp.apply({ enabled: false, port: 0 })
    expect(mcp.status()).toEqual({ enabled: false, running: false })
    await mcp.apply({ enabled: true, port: 0 })
    const on = mcp.status()
    expect(on).toMatchObject({ enabled: true, running: true, token: stored[MCP_TOKEN_NAME] })
    expect(on.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    // the endpoint answers with that token
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(new StreamableHTTPClientTransport(new URL(on.url!), { requestInit: { headers: { Authorization: `Bearer ${on.token}` } } }))
    expect((await c.listTools()).tools.length).toBeGreaterThan(10)
    await c.close()
    // a busy port is reported, not thrown
    const taken = await startMcpHttp({ port: 0, token: 'x', factory: () => createMcpServer(dispatcher, r!.service, bus) })
    server = taken
    await mcp.apply({ enabled: true, port: taken.port })
    expect(mcp.status()).toMatchObject({ enabled: true, running: false, error: `port ${taken.port} is already in use` })
    await mcp.apply({ enabled: false, port: 0 })
    expect(mcp.status()).toEqual({ enabled: false, running: false })
    await mcp.stop()
  })
})
