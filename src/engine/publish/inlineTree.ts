import type { Block } from '../../shared/ir'
import { stripTags, validateTags } from '../formats/inline'

/** Parsed placeholder text: nested pairs, voids and text. */
export type InlineNode = { type: 'text'; text: string } | { type: 'pair'; n: number; children: InlineNode[] } | { type: 'void'; n: number }

const TAG = /<(\/?)(\d+)(\/?)>/g

/** Parses placeholder text into a tree. Expects tags that already passed `validateTags`; stray closers are kept as text. */
export function parseInline(text: string): InlineNode[] {
  const root: InlineNode[] = []
  const stack: { n: number; children: InlineNode[] }[] = []
  const cur = () => (stack.length ? stack[stack.length - 1]!.children : root)
  const pushText = (s: string) => {
    if (!s) return
    const list = cur()
    const last = list[list.length - 1]
    if (last && last.type === 'text') last.text += s
    else list.push({ type: 'text', text: s })
  }
  let pos = 0
  for (const m of text.matchAll(TAG)) {
    pushText(text.slice(pos, m.index))
    pos = m.index + m[0].length
    const closing = m[1] === '/'
    const selfClosing = m[3] === '/'
    const n = Number(m[2])
    if (closing && selfClosing) pushText(m[0])
    else if (selfClosing) cur().push({ type: 'void', n })
    else if (!closing) {
      const node = { type: 'pair' as const, n, children: [] as InlineNode[] }
      cur().push(node)
      stack.push(node)
    } else if (stack.length && stack[stack.length - 1]!.n === n) stack.pop()
    else pushText(m[0])
  }
  pushText(text.slice(pos))
  return root
}

/**
 * The inline nodes to write for a translated block. A translation whose placeholder tags do not match the source block
 * is written as plain text (tags stripped) instead.
 */
export function resolveTranslation(block: Pick<Block, 'text' | 'tags'>, translated: string): InlineNode[] {
  if (block.tags.length === 0) return translated ? [{ type: 'text', text: stripTags(translated) }] : []
  if (validateTags(block.text, translated).ok) return parseInline(translated)
  const plain = stripTags(translated)
  return plain ? [{ type: 'text', text: plain }] : []
}
