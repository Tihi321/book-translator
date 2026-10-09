import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { chatJson, cleanProse, extractJson, stripThinking } from '../src/engine/pipeline/llm'
import type { ChatFn } from '../src/engine/pipeline/llm'
import { buildMessages, render } from '../src/engine/pipeline/prompts'
import { tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe('llm helpers', () => {
  it('strips thinking and extracts JSON from fenced replies', () => {
    expect(stripThinking('<think>hmm</think>\nAnswer')).toBe('Answer')
    expect(extractJson('<think>x</think>Here: {"a": 1} done')).toEqual({ a: 1 })
    expect(cleanProse('```\ntext\n```')).toBe('text')
  })

  it('chatJson repairs once and sums the cost', async () => {
    const replies = ['not json', '{"n": 3}']
    const seen: boolean[] = []
    const chat: ChatFn = async (req) => {
      seen.push(!!req.schema)
      return { text: replies.shift()!, costUsd: 0.5 }
    }
    const r = await chatJson(chat, [{ role: 'user', content: 'go' }], z.object({ n: z.number() }))
    expect(r.value).toEqual({ n: 3 })
    expect(r.cost).toBe(1)
    expect(seen).toEqual([true, false])
  })

  it('chatJson retries without the schema when the first call throws, and fails after two bad replies', async () => {
    let calls = 0
    const chat: ChatFn = async (req) => {
      calls++
      if (req.schema) throw new Error('schema not supported')
      return { text: 'nope', costUsd: 0 }
    }
    await expect(chatJson(chat, [], z.object({ n: z.number() }))).rejects.toThrow('did not return valid JSON')
    expect(calls).toBe(3)
  })

  it('renders templates and builds messages from the data folder', async () => {
    expect(render('Hi {{ name }}{{missing}}!', { name: 'A' })).toBe('Hi A!')
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await fs.mkdir(path.join(dir, 'prompts'), { recursive: true })
    await fs.writeFile(path.join(dir, 'prompts', '_rules.md'), 'RULES', 'utf8')
    await fs.writeFile(path.join(dir, 'prompts', 'translator.md'), '---\nkind: prompt\n---\nTranslate to {{lang}}.', 'utf8')
    const msgs = await buildMessages(dir, 'translator', { lang: 'Croatian' }, 'text')
    expect(msgs).toEqual([
      { role: 'system', content: 'RULES\n\nTranslate to Croatian.' },
      { role: 'user', content: 'text' }
    ])
    await expect(buildMessages(dir, 'nope', {}, '')).rejects.toThrow('prompt template missing')
  })
})
