import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MockProvider } from '../src/engine/models/mock'
import type { MockReply } from '../src/engine/models/mock'
import type { ChatRequest } from '../src/engine/models/types'
import { EngineService } from '../src/engine/service'
import type { ProjectSettings } from '../src/shared/project'
import type { EngineEvent } from '../src/shared/protocol'
import { seededRegistry } from './helpers'

export const MODEL = 'mock/mock-translator'
export const QA_MODEL = 'mock/mock-reviewer'

export const lastUser = (req: ChatRequest) => req.messages[req.messages.length - 1]!.content

/** The `<seg id="..">text</seg>` elements of a request, or of any tag name. */
export function segsIn(content: string, tag = 'seg'): { id: string; text: string }[] {
  const re = new RegExp(`<${tag} id="([^"]+)">([\\s\\S]*?)</${tag}>`, 'g')
  return [...content.matchAll(re)].map((m) => ({ id: m[1]!, text: m[2]! }))
}

export const asSegs = (segs: { id: string; text: string }[]) => segs.map((s) => `<seg id="${s.id}">${s.text}</seg>`).join('\n')

/** Scripted answers for every agent. Tests add their own rules on top (the last matching rule wins). */
export function scriptMock(mock: MockProvider, prefix = '[hr] '): void {
  mock.on({ role: 'translator' }, (req) => {
    if (req.meta?.task === 'fix') return asSegs(segsIn(lastUser(req), 'cur').map((s) => ({ id: s.id, text: `[fixed] ${s.text}` })))
    return asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: prefix + s.text })))
  })
  mock.on({ role: 'proofreader' }, (req) => asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: `${s.text} ✓` }))))
  mock.on({ role: 'qa' }, '{"issues":[]}')
  mock.on(
    { role: 'glossary' },
    JSON.stringify({
      terms: [{ source: 'Alice', target: 'Alisa', type: 'person', gender: 'f', note: 'main character' }, { source: 'Bob', target: 'Bob', type: 'person', gender: 'm' }],
      brief: { genre: 'fiction', tone: 'light', register: 'neutral', pov: 'third person', address: 'informal', characters: [{ name: 'Alice', gender: 'f', note: 'protagonist' }] }
    })
  )
}

export function bookText(chapters = 2, paras = 12): string {
  const out: string[] = ['# Test Book', '']
  for (let c = 1; c <= chapters; c++) {
    out.push(`## Chapter ${c}`, '')
    for (let p = 1; p <= paras; p++) out.push(`Paragraph ${p} of chapter ${c}: Alice met Bob in the garden near the old oak tree.`, '')
    if (c === 1) out.push('```js', 'const code = 1', '```', '')
  }
  return out.join('\n')
}

export interface Rig {
  dir: string
  service: EngineService
  mock: MockProvider
  events: EngineEvent[]
  file: string
  cleanup: () => Promise<void>
  create: (settings?: Partial<ProjectSettings>) => Promise<string>
  calls: (role: string, task?: string) => { unit?: string; task?: string }[]
}

export async function rig(opts: { content?: string; delay?: number; script?: boolean; onEvent?: (e: EngineEvent) => void } = {}): Promise<Rig> {
  const mock = new MockProvider('mock', { chunkDelayMs: opts.delay ?? 1, chunks: 2 })
  const { dir, registry, cleanup } = await seededRegistry({ mock })
  const file = path.join(dir, 'book.md')
  await fs.writeFile(file, opts.content ?? bookText(), 'utf8')
  const events: EngineEvent[] = []
  const service = new EngineService({ dataDir: dir, registry, emit: (e) => {
      events.push(e)
      opts.onEvent?.(e)
    }, routerOptions: { retries: 0, backoffMs: 1 } })
  if (opts.script !== false) scriptMock(mock)
  const create = async (settings: Partial<ProjectSettings> = {}) => {
    const p = await service.createProject({
      sourcePath: file,
      targetLanguage: 'Croatian',
      sourceLanguage: 'English',
      settings: {
        agentModels: { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] },
        enabled: { glossary: false, proofreader: false, qa: false },
        maxChunkTokens: 100,
        ...settings
      }
    })
    return p.id
  }
  const calls = (role: string, task?: string) => mock.calls.filter((c) => c.meta?.role === role && (!task || c.meta?.task === task)).map((c) => ({ unit: c.meta?.unit, task: c.meta?.task }))
  return { dir, service, mock, events, file, cleanup, create, calls }
}

export type { MockReply }
