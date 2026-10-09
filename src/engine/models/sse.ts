export interface SseMessage {
  event?: string
  data: string
}

/** Parses a Server-Sent Events body into messages. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '')
        const msg = toMessage(raw)
        if (msg) yield msg
      }
    }
    buf += decoder.decode()
    const last = toMessage(buf)
    if (last) yield last
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

function toMessage(raw: string): SseMessage | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':') || line === '') continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length ? { event, data: data.join('\n') } : null
}
