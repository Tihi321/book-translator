import { describe, expect, it } from 'vitest'
import { OpenAiCompatClient } from '../src/engine/models/openaiCompat'
import { collect } from '../src/engine/models/types'

/** A fetch stub that answers with an SSE stream and records the request body. */
function sseFetch(chunks: string[]): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fetchImpl, bodies }
}

const STREAM = [
  'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"{}"}}]}\n\n',
  'data: [DONE]\n\n'
]

describe('OpenAiCompatClient response_format', () => {
  const schema = { type: 'object' }
  const messages = [{ role: 'user' as const, content: 'hi' }]

  it('sends the JSON schema as response_format by default', async () => {
    const { fetchImpl, bodies } = sseFetch(STREAM)
    const client = new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl })
    const r = await collect(client.chat({ model: 'm', messages, schema }))
    expect(bodies[0]!.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema } })
    expect(r.text).toBe('{}')
  })

  it('leaves response_format out with jsonSchema: false, and reasoning_content is not text', async () => {
    const { fetchImpl, bodies } = sseFetch(STREAM)
    const client = new OpenAiCompatClient({ id: 'x', baseUrl: 'http://x/v1', fetchImpl, jsonSchema: false })
    const r = await collect(client.chat({ model: 'm', messages, schema }))
    expect(bodies[0]).not.toHaveProperty('response_format')
    expect(r.text).toBe('{}')
  })
})
