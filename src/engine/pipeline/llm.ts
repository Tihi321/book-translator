import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ChatMessage } from '../models/types'

/** Removes reasoning blocks some models put in their answer. */
export function stripThinking(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const close = t.toLowerCase().lastIndexOf('</think>')
  if (close !== -1) t = t.slice(close + 8)
  return t.replace(/^\s+/, '')
}

/** Prose from a model: no reasoning blocks, no code fences around the whole text, trimmed. */
export function cleanProse(text: string): string {
  let t = stripThinking(text).trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence) t = fence[1]!.trim()
  return t
}

/** Pulls the first JSON object out of a reply, tolerating fences and chatter around it. */
export function extractJson(text: string): unknown {
  let t = stripThinking(text).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1]!.trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply')
  return JSON.parse(t.slice(start, end + 1))
}

export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

/** What chatJson needs from the caller: one reply for a set of messages (the caller picks the models and sums the cost). */
export interface LlmReply {
  text: string
  costUsd: number
}

export type ChatFn = (req: { messages: ChatMessage[]; schema?: Record<string, unknown>; maxTokens?: number; temperature?: number }) => Promise<LlmReply>

export interface JsonResult<T> {
  value: T
  reply: LlmReply
  /** Cost of all requests made, repair retries included. */
  cost: number
}

/**
 * Asks for JSON. Passes the schema to providers that support it. If the reply doesn't parse or validate,
 * asks once more with the error (a repair retry). If the provider rejects the schema, tries again without it.
 */
export async function chatJson<T>(
  chat: ChatFn,
  messages: ChatMessage[],
  schema: ZodType<T>,
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}
): Promise<JsonResult<T>> {
  let cost = 0
  const jsonSchema = jsonSchemaOf(schema)
  const { signal, ...rest } = opts
  const ask = async (msgs: ChatMessage[], withSchema: boolean): Promise<LlmReply> => {
    const r = await chat({ messages: msgs, schema: withSchema ? jsonSchema : undefined, ...rest })
    cost += r.costUsd
    return r
  }
  let reply: LlmReply
  try {
    reply = await ask(messages, true)
  } catch (err) {
    if (signal?.aborted || (err as Error).name === 'AbortError' || /token limit/i.test((err as Error).message)) throw err
    reply = await ask(messages, false)
  }
  const tryParse = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      const parsed = schema.safeParse(extractJson(text))
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  let parsed = tryParse(reply.text)
  if (parsed.ok) return { value: parsed.value, reply, cost }
  const repair: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: reply.text.slice(0, 6000) },
    {
      role: 'user',
      content: `Your reply could not be used: ${parsed.error}.
Reply again with only one valid JSON object that matches the requested format. No explanations, no code fences.`
    }
  ]
  const second = await ask(repair, false)
  parsed = tryParse(second.text)
  if (parsed.ok) return { value: parsed.value, reply: second, cost }
  throw new Error(`the model did not return valid JSON twice: ${parsed.error}`)
}
