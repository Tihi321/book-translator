import type { MockProvider } from './mock'
import type { ChatRequest } from './types'

/** Makes `mock/...` models usable outside the tests: they echo the segments with a prefix, and QA and the glossary find nothing. */
export function scriptDevMock(mock: MockProvider): void {
  const echo = (req: ChatRequest, prefix: string) => {
    const user = req.messages[req.messages.length - 1]!.content
    return [...user.matchAll(/<seg id="([^"]+)">([\s\S]*?)<\/seg>/g)].map((m) => `<seg id="${m[1]}">${prefix}${m[2]}</seg>`).join('\n')
  }
  mock.on({ role: 'translator' }, (req) => echo(req, '[mock] '))
  mock.on({ role: 'proofreader' }, (req) => echo(req, ''))
  mock.on({ role: 'qa' }, '{"issues":[]}')
  mock.on({ role: 'glossary' }, '{"terms":[]}')
}
