import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineBus } from '../src/engine/bus'
import { CommandDispatcher } from '../src/engine/dispatcher'
import { startMcpHttp } from '../src/engine/mcp/http'
import type { McpHttp } from '../src/engine/mcp/http'
import { createMcpServer } from '../src/engine/mcp/server'
import { checkAgainstSchema, ClientProvider, ClientTaskQueue, clientTaskResult, GONE } from '../src/engine/models/client'
import { ModelRouter } from '../src/engine/models/router'
import { collect } from '../src/engine/models/types'
import { translate } from '../src/engine/cli'
import { z } from 'zod'
import { chatJson, jsonSchemaOf } from '../src/engine/pipeline/llm'
import type { ChatFn } from '../src/engine/pipeline/llm'
import { rig } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

const REF = 'client/claude-code'
const MSGS = [
  { role: 'system' as const, content: 'rules' },
  { role: 'user' as const, content: 'hello world' }
]
const SCHEMA = { type: 'object', properties: { title: { type: 'string' }, n: { type: 'integer' } }, required: ['title'] }

let r: Rig | undefined
let server: McpHttp | undefined
let mcp: Client | undefined
afterEach(async () => {
  await mcp?.close().catch(() => undefined)
  await server?.close()
  await r?.cleanup()
  r = server = mcp = undefined
})

/** A rig whose providers.md has the client provider switched on (the seed has it enabled; an older data folder has it disabled). */
async function clientRig(): Promise<Rig> {
  const rg = await rig()
  const file = path.join(rg.dir, 'config', 'providers.md')
  const text = await fs.readFile(file, 'utf8')
  const on = text.replace(/(id: client\r?\n\s+kind: client\r?\n\s+)enabled: false/, '$1enabled: true')
  expect(/id: client\r?\n\s+kind: client\r?\n\s+enabled: true/.test(on)).toBe(true)
  await fs.writeFile(file, on)
  await rg.service.registry.load()
  return rg
}

/** Answers every task like the scripted mock would, until stopped. */
function answerLoop(rg: Rig): () => void {
  let stop = false
  void (async () => {
    while (!stop) {
      const t = rg.service.clientQueue.lease()
      if (!t) {
        await new Promise((res) => setTimeout(res, 3))
        continue
      }
      const { text } = await collect(rg.mock.chat({ model: 'mock-translator', messages: t.messages, schema: t.schema, meta: { role: t.role, task: t.task, project: t.project, unit: t.unit } }))
      rg.service.clientQueue.submit(t.id, text)
    }
  })()
  return () => {
    stop = true
  }
}

describe('ClientTaskQueue', () => {
  it('leases the oldest matching task, and a lease that runs out puts it back', () => {
    let now = 1000
    const q = new ClientTaskQueue({ now: () => now })
    q.add({ messages: MSGS }, { job: 'p--chunk-1--translate', role: 'translator', task: 'translate', project: 'p' })
    q.add({ messages: MSGS }, { job: 'p--chunk-1--proofread', role: 'proofreader', task: 'proofread', project: 'p' })
    q.add({ messages: MSGS })
    expect(q.counts()).toEqual({ waiting: 3, leased: 0 })
    const a = q.lease({ role: 'proofreader' }, 5000)!
    expect(a.id).toBe('p--chunk-1--proofread#1')
    expect(q.lease({ project: 'other' })).toBeNull()
    expect(q.lease({})!.id).toBe('p--chunk-1--translate#1')
    expect(q.lease({})!.id).toBe('adhoc-1#1')
    expect(q.lease({})).toBeNull()
    expect(q.counts()).toEqual({ waiting: 0, leased: 3 })
    expect(q.list().find((t) => t.id === a.id)).toMatchObject({ state: 'leased', leaseMsLeft: 5000, role: 'proofreader' })
    now += 6000 // the 5 s lease is over, the 30 min ones are not
    expect(q.counts()).toEqual({ waiting: 1, leased: 2 })
    expect(q.lease({ role: 'proofreader' })!.id).toBe(a.id)
    expect(q.release(a.id)).toBe(true)
    expect(q.release('nope#1')).toBe(false)
  })

  it('leases for 10 minutes by default, renews a lease on a refused answer, and releases leased tasks by project', () => {
    let now = 0
    const q = new ClientTaskQueue({ now: () => now })
    q.add({ messages: MSGS, schema: SCHEMA }, { job: 'a', role: 'translator', project: 'p' })
    q.add({ messages: MSGS }, { job: 'b', role: 'qa', project: 'p' })
    q.add({ messages: MSGS }, { job: 'c', role: 'qa', project: 'other' })
    const a = q.lease({ role: 'translator' })!
    expect((clientTaskResult(a) as { leaseMinutes: number }).leaseMinutes).toBe(10)
    now += 9 * 60_000
    expect(q.submit('a#1', 'not json')).toMatchObject({ accepted: false })
    now += 9 * 60_000 // 18 minutes after the lease, but the refused answer started it again
    expect(q.counts()).toEqual({ waiting: 2, leased: 1 })
    now += 2 * 60_000
    expect(q.counts()).toEqual({ waiting: 3, leased: 0 })
    q.lease({ role: 'qa', project: 'p' }, 90 * 1000)
    q.lease({ role: 'qa', project: 'other' })
    q.lease({ role: 'translator' })
    expect(q.releaseLeased({ project: 'p', role: 'qa' })).toBe(1)
    expect(q.counts()).toEqual({ waiting: 1, leased: 2 })
    expect(q.releaseLeased({ project: 'p' })).toBe(1)
    expect(q.releaseLeased({ project: 'p' })).toBe(0)
  })

  it('numbers the calls of a job and checks a schema on submit, keeping the task leased on failure', async () => {
    const q = new ClientTaskQueue()
    const first = q.add({ messages: MSGS, schema: SCHEMA }, { job: 'j' })
    expect(first.task.id).toBe('j#1')
    expect(q.add({ messages: MSGS }, { job: 'j' }).task.id).toBe('j#2')
    q.lease({})
    expect(q.submit('j#1', 'no json at all')).toMatchObject({ accepted: false })
    expect(q.submit('j#1', '{"n": 2}')).toEqual({ accepted: false, problems: ['title: missing (required)'] })
    expect(q.submit('j#1', '{"title": 5}')).toEqual({ accepted: false, problems: ['title: expected string, got number'] })
    expect(q.submit('j#1', '  ')).toEqual({ accepted: false, problems: ['the text is empty'] })
    expect(q.counts().leased).toBe(1)
    expect(q.submit('j#1', '```json\n{"title": "ok"}\n```')).toEqual({ accepted: true })
    expect(await first.done).toContain('"ok"')
    expect(q.submit('j#1', '{"title":"x"}')).toEqual({ accepted: false, problems: [GONE] })
    expect(checkAgainstSchema('{"title":"x"}', SCHEMA)).toEqual([])
  })
})

describe('named clients', () => {
  it('a task is for one client: a lease without client gets claude-code tasks only', () => {
    const q = new ClientTaskQueue()
    q.add({ messages: MSGS, client: 'antigravity' }, { job: 'a', role: 'translator', project: 'p' })
    q.add({ messages: MSGS }, { job: 'b', role: 'translator', project: 'p' })
    q.add({ messages: MSGS, client: 'claude-code' }, { job: 'c', role: 'translator', project: 'p' })
    expect(q.list().map((t) => [t.id, t.client])).toEqual([['a#1', 'antigravity'], ['b#1', 'claude-code'], ['c#1', 'claude-code']])
    expect(q.lease({})!.id).toBe('b#1')
    expect(q.lease({ client: 'claude-code' })!.id).toBe('c#1')
    expect(q.lease({})).toBeNull()
    expect(q.lease({ client: 'other' })).toBeNull()
    const t = q.lease({ client: 'antigravity' })!
    expect(t).toMatchObject({ id: 'a#1', client: 'antigravity' })
    expect((clientTaskResult(t) as { meta: { client: string } }).meta.client).toBe('antigravity')
  })

  it('releaseLeased takes every client unless one is named', () => {
    const q = new ClientTaskQueue()
    q.add({ messages: MSGS, client: 'antigravity' }, { job: 'a', project: 'p' })
    q.add({ messages: MSGS }, { job: 'b', project: 'p' })
    q.lease({ client: 'antigravity' })
    q.lease({})
    expect(q.releaseLeased({ client: 'antigravity' })).toBe(1)
    expect(q.releaseLeased({ project: 'p' })).toBe(1)
  })

  it('ClientProvider makes the task for the model it was asked for', async () => {
    const q = new ClientTaskQueue()
    const provider = new ClientProvider('client', q)
    const run = collect(provider.chat({ model: 'antigravity', messages: MSGS, meta: { job: 'j', project: 'p' } }))
    expect(q.lease({})).toBeNull()
    const t = q.lease({ client: 'antigravity' })!
    expect(t.client).toBe('antigravity')
    q.submit(t.id, 'answer')
    expect((await run).text).toBe('answer')
  })
})

describe('clientTaskResult', () => {
  type Msg = { role: 'system' | 'user' | 'assistant'; content: string }
  const lease = (messages: Msg[]) => {
    const q = new ClientTaskQueue()
    q.add({ messages }, { job: 'j', role: 'translator', task: 'translate', project: 'p' })
    const t = clientTaskResult(q.lease({})!)
    if ('none' in t) throw new Error('no task')
    return t
  }

  it('leaves out messages for a system + user request', () => {
    const t = lease(MSGS)
    expect(t.system).toBe('rules')
    expect(t.user).toBe('hello world')
    expect(t.messages).toBeUndefined()
    expect('messages' in t).toBe(false)
  })

  it('leaves out messages when there are only more system messages', () => {
    const t = lease([{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'hi' }])
    expect(t.system).toBe('a\n\nb')
    expect(t.messages).toBeUndefined()
  })

  it('gives messages for a repair round (an assistant turn)', () => {
    const t = lease([...MSGS, { role: 'assistant', content: 'bad json' }, { role: 'user', content: 'fix it' }])
    expect(t.messages?.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(t.messages?.[2]?.content).toBe('bad json')
    expect(t.user).toBe('hello world\n\nbad json\n\nfix it')
  })

  it('gives messages for several user messages', () => {
    const t = lease([...MSGS, { role: 'user', content: 'and this' }])
    expect(t.messages).toHaveLength(3)
  })

  it('a JSON repair round of chatJson reaches the client as a task with an assistant turn', async () => {
    r = await clientRig()
    const router = new ModelRouter(r.service.registry)
    // the title passes the queue's schema check (a string) but not zod's refine (at least 4 characters, which JSON schema cannot say)
    const zodSchema = z.object({ title: z.string().refine((t) => t.length >= 4) })
    const chat: ChatFn = async (req) => {
      const res = await router.complete([REF], { messages: req.messages, schema: req.schema, meta: { role: 'glossary', task: 'glossary', project: 'p', job: 'p--glossary' } })
      return { text: res.text, costUsd: res.costUsd }
    }
    const done = chatJson(chat, MSGS, zodSchema)
    const queue = r.service.clientQueue
    const take = async () => {
      for (let i = 0; i < 200; i++) {
        const t = queue.lease({ project: 'p' })
        if (t) return t
        await new Promise((res) => setTimeout(res, 5))
      }
      throw new Error('no task came')
    }
    const first = await take()
    expect(first.id).toBe('p--glossary#1')
    expect(clientTaskResult(first)).not.toHaveProperty('messages')
    expect(queue.submit(first.id, '{"title":"ab"}')).toEqual({ accepted: true })
    const second = await take()
    expect(second.id).toBe('p--glossary#2')
    const result = clientTaskResult(second)
    expect('messages' in result && result.messages?.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(queue.submit(second.id, '{"title":"abcd"}')).toEqual({ accepted: true })
    expect((await done).value).toEqual({ title: 'abcd' })
  })
})

describe('checkAgainstSchema and zod defaults', () => {
  it('accepts an answer that leaves out a field that has a default', () => {
    const schema = jsonSchemaOf(z.object({ title: z.string(), tone: z.string().default('neutral') }))
    expect((schema.required as string[]).includes('tone')).toBe(true)
    expect(checkAgainstSchema('{"title":"x"}', schema)).toEqual([])
    expect(checkAgainstSchema('{"tone":"x"}', schema)).toEqual(['title: missing (required)'])
  })
})

describe('client provider in the registry and router', () => {
  it('resolves as local and free, answers through the queue and costs nothing', async () => {
    r = await clientRig()
    const reg = r.service.registry
    const model = reg.getModel(REF)!
    expect(model.provider).toMatchObject({ kind: 'client', local: true, available: true, concurrency: 8 })
    expect(model.provider.client).toBeInstanceOf(ClientProvider)
    const router = new ModelRouter(reg)
    const done = router.complete([REF], { messages: MSGS, meta: { role: 'translator', task: 'translate', project: 'p', unit: 'chunk-1', job: 'p--chunk-1--translate' } })
    await new Promise((res) => setTimeout(res, 5))
    const t = r.service.clientQueue.lease({ project: 'p' })!
    expect(t).toMatchObject({ id: 'p--chunk-1--translate#1', role: 'translator', unit: 'chunk-1' })
    expect(r.service.clientQueue.submit(t.id, 'a reply of 20 chars!!')).toEqual({ accepted: true })
    const res = await done
    expect(res.text).toBe('a reply of 20 chars!!')
    expect(res.costUsd).toBe(0)
    expect(res.usage.outputTokens).toBe(6)
  })

  it('keeps a parked task across a providers.md reload', async () => {
    r = await clientRig()
    const dispatcher = new CommandDispatcher({ service: r.service, emit: () => undefined, showMock: true })
    const done = r.service.router.complete([REF], { messages: MSGS, meta: { role: 'translator', task: 'translate', project: 'p', unit: 'chunk-1', job: 'p--chunk-1--translate' } })
    await new Promise((res) => setTimeout(res, 5))
    const file = path.join(r.dir, 'config', 'providers.md')
    const text = await fs.readFile(file, 'utf8')
    // the client provider has `concurrency: 8` in the seed
    const edited = text.replace(/(id: client[\s\S]*?concurrency: )8/, (_m, head: string) => `${head}4`)
    expect(edited).not.toBe(text)
    await fs.writeFile(file, edited)
    const later = new Date(Date.now() + 5000)
    await fs.utimes(file, later, later)
    expect(await dispatcher.reloadConfigIfChanged()).toBe(true)
    expect(r.service.registry.providers.get('client')!.concurrency).toBe(4)
    const t = r.service.clientQueue.lease({ project: 'p' })!
    expect(t.id).toBe('p--chunk-1--translate#1')
    expect(r.service.clientQueue.submit(t.id, 'still answered')).toEqual({ accepted: true })
    expect((await done).text).toBe('still answered')
  })

  it('drops the task when the request is aborted, and a later submit finds it gone', async () => {
    r = await clientRig()
    const router = new ModelRouter(r.service.registry)
    const ctl = new AbortController()
    const done = router.complete([REF], { messages: MSGS, signal: ctl.signal, meta: { job: 'j' } })
    const caught = done.catch((e: Error) => e)
    await new Promise((res) => setTimeout(res, 5))
    expect(r.service.clientQueue.counts().waiting).toBe(1)
    ctl.abort()
    expect(((await caught) as Error).name).toBe('AbortError')
    expect(r.service.clientQueue.counts()).toEqual({ waiting: 0, leased: 0 })
    expect(r.service.clientQueue.submit('j#1', 'x')).toEqual({ accepted: false, problems: [GONE] })
  })
})

describe('a whole project on the client provider', () => {
  it('runs glossary, translator, proofreader and QA, all answered through the queue', async () => {
    r = await clientRig()
    const id = await r.create({
      agentModels: { glossary: [REF], translator: [REF], proofreader: [REF], qa: [REF] },
      enabled: { glossary: true, proofreader: true, qa: true }
    })
    const stop = answerLoop(r)
    try {
      const res = await r.service.start(id)
      expect(res.status).toBe('done')
      expect(res.spend.costUsd).toBe(0)
    } finally {
      stop()
    }
    expect(r.mock.calls.some((c) => c.meta?.role === 'glossary')).toBe(true)
    expect(r.mock.calls.some((c) => c.meta?.role === 'proofreader')).toBe(true)
    expect(r.mock.calls.some((c) => c.meta?.role === 'qa')).toBe(true)
    const chunks = await r.service.store.listChunks(id)
    expect(chunks.every((c) => c.state === 'done' && c.model === REF)).toBe(true)
    expect(r.service.clientQueue.counts()).toEqual({ waiting: 0, leased: 0 })
  })
})

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] }

async function connect() {
  const bus = new EngineBus()
  r = await clientRig()
  const dispatcher = new CommandDispatcher({ service: r.service, emit: (e) => bus.emit(e), showMock: true, keys: () => undefined, storeKey: () => undefined })
  const svc = r.service
  server = await startMcpHttp({ port: 0, token: 't', factory: () => createMcpServer(dispatcher, svc, bus) })
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: 'Bearer t' } } }))
  mcp = c
  return c
}

async function call<T>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = (await c.callTool({ name, arguments: args })) as ToolResult
  if (res.isError) throw new Error(res.content[0]!.text)
  return JSON.parse(res.content[0]!.text) as T
}

describe('client provider over MCP', () => {
  it('sets agentModels to client/claude-code, lists, gets, submits and releases tasks', async () => {
    const c = await connect()
    const names = (await c.listTools()).tools.map((t) => t.name)
    for (const n of ['list_client_tasks', 'get_client_task', 'submit_client_task', 'release_client_task']) expect(names).toContain(n)

    const created = await call<{ id: string }>(c, 'create_project', { sourcePath: r!.file, targetLanguage: 'Croatian', enabledAgents: { glossary: false, proofreader: false, qa: false }, maxChunkTokens: 100 })
    const id = created.id
    const updated = await call<{ project: { settings: { agentModels: Record<string, string[]> } } }>(c, 'update_project_settings', { projectId: id, agentModels: { translator: [REF], qa: [REF] } })
    expect(updated.project.settings.agentModels.translator).toEqual([REF])

    expect(await call(c, 'get_client_task', {})).toEqual({ none: true, waiting: 0 })
    await call(c, 'start_translation', { projectId: id })
    // the run asks for the first chunk: wait_for_progress returns at once with the count
    let waiting = 0
    for (let i = 0; i < 100 && waiting === 0; i++) {
      await new Promise((res) => setTimeout(res, 20))
      waiting = r!.service.clientQueue.counts().waiting
    }
    const t0 = Date.now()
    const prog = await call<{ clientTasks: { waiting: number; leased: number }; timedOut: boolean }>(c, 'wait_for_progress', { projectId: id, timeoutSec: 30 })
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(prog.clientTasks.waiting).toBeGreaterThan(0)
    expect(prog.timedOut).toBe(false)
    expect((await call<{ clientTasks: { waiting: number } }>(c, 'get_project', { projectId: id })).clientTasks.waiting).toBeGreaterThan(0)

    const list = await call<{ waiting: number; leased: number; tasks: { id: string; state: string; project: string }[] }>(c, 'list_client_tasks')
    expect(list.tasks[0]).toMatchObject({ state: 'waiting', project: id })

    const task = await call<{ taskId: string; meta: { role: string; task: string; project: string }; system: string; user: string; output: string; messages?: unknown[]; leaseMinutes: number }>(c, 'get_client_task', { role: 'translator' })
    expect(task.meta).toMatchObject({ role: 'translator', task: 'translate', project: id })
    expect(task.taskId.startsWith(`${id}--chunk-`)).toBe(true)
    expect(task.taskId.endsWith('--translate#1')).toBe(true)
    expect(task.output).toContain('<seg id')
    expect(task.user).toContain('<seg id=')
    expect(task.system.length).toBeGreaterThan(0)
    expect(task.messages).toBeUndefined()
    expect(task.leaseMinutes).toBe(10)
    expect(await call(c, 'release_client_task', { taskId: task.taskId })).toEqual({ released: true })
    expect(await call(c, 'release_client_task', { taskId: 'zzz#1' })).toEqual({ released: false })

    // a role filter: nothing of another role ends the wait; a leased task can be freed by project, with a shorter lease asked for
    const t0b = Date.now()
    const qaWait = await call<{ clientTasks: { waiting: number; role?: string }; timedOut: boolean }>(c, 'wait_for_progress', { projectId: id, timeoutSec: 1, role: 'qa' })
    expect(Date.now() - t0b).toBeGreaterThanOrEqual(900)
    expect(qaWait).toMatchObject({ timedOut: true, clientTasks: { waiting: 0, role: 'qa' } })
    const again = await call<{ taskId: string; leaseMinutes: number }>(c, 'get_client_task', { role: 'translator', leaseMinutes: 3 })
    expect(again.leaseMinutes).toBe(3)
    expect(await call(c, 'release_client_task', { project: id })).toEqual({ released: 1 })
    await expect(call(c, 'release_client_task', {})).rejects.toThrow(/taskId/)

    // answer every task like the mock translator would, until the project is done
    const stop = answerLoop(r!)
    try {
      for (let i = 0; i < 100; i++) {
        const p = await call<{ status: string }>(c, 'wait_for_progress', { projectId: id, timeoutSec: 5 })
        if (p.status === 'done') break
      }
    } finally {
      stop()
    }
    expect((await call<{ status: string }>(c, 'wait_for_progress', { projectId: id, timeoutSec: 1 })).status).toBe('done')
    expect(await call(c, 'submit_client_task', { taskId: task.taskId, text: 'late' })).toEqual({ accepted: false, problems: [GONE] })
  })

  it('get_client_task takes a client: Antigravity gets its own tasks and a call without client only claude-code ones', async () => {
    const c = await connect()
    const queue = r!.service.clientQueue
    queue.add({ messages: MSGS, client: 'antigravity' }, { job: 'ag', role: 'translator', project: 'p' })
    queue.add({ messages: MSGS }, { job: 'cc', role: 'translator', project: 'p' })
    const tool = (await c.listTools()).tools.find((t) => t.name === 'get_client_task')!
    expect(tool.description).toContain('antigravity')
    const listed = await call<{ tasks: { id: string; client: string }[] }>(c, 'list_client_tasks')
    expect(listed.tasks.map((t) => [t.id, t.client])).toEqual([['ag#1', 'antigravity'], ['cc#1', 'claude-code']])
    expect(await call<{ taskId: string; meta: { client: string } }>(c, 'get_client_task', {})).toMatchObject({ taskId: 'cc#1', meta: { client: 'claude-code' } })
    expect(await call(c, 'get_client_task', {})).toMatchObject({ none: true })
    expect(await call(c, 'get_client_task', { client: 'other' })).toMatchObject({ none: true })
    expect(await call<{ taskId: string }>(c, 'get_client_task', { client: 'antigravity' })).toMatchObject({ taskId: 'ag#1' })
    expect(await call(c, 'release_client_task', { client: 'antigravity', project: 'p' })).toEqual({ released: 1 })
  })

  it('shows the prompt for the full pipeline', async () => {
    const c = await connect()
    const names = (await c.listPrompts()).prompts.map((p) => p.name)
    expect(names).toContain('translate_with_full_pipeline')
  })
})

describe('CLI translate', () => {
  it('refuses a project with an agent on client/*', async () => {
    r = await clientRig()
    const err: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: string) => (err.push(String(c)), true)) as never
    try {
      expect(await translate([r.file, '--to', 'hr', '--data', r.dir, '--model', REF, '--no-glossary', '--no-proofread', '--no-qa'])).toBe(2)
    } finally {
      process.stderr.write = write
    }
    expect(err.join('')).toContain('client/claude-code')
    expect(err.join('')).toContain('nothing would ever answer')
  })
})
