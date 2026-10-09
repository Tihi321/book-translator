/** Inline placeholder tags: `<1>text</1>` (pair) and `<2/>` (void). */

const TAG_RE = /<(\/?)(\d+)(\/?)>/g

export interface TagToken {
  n: number
  type: 'open' | 'close' | 'void'
}

/** The placeholder tags of a text, in order of appearance. */
export function tagTokens(text: string): TagToken[] {
  const out: TagToken[] = []
  for (const m of text.matchAll(TAG_RE)) {
    const closing = m[1] === '/'
    const selfClosing = m[3] === '/'
    if (closing && selfClosing) continue // `</1/>` is not a tag
    out.push({ n: Number(m[2]), type: closing ? 'close' : selfClosing ? 'void' : 'open' })
  }
  return out
}

const key = (t: TagToken) => `${t.type}:${t.n}`

export interface TagCheck {
  ok: boolean
  /** Tags in the source but not (often enough) in the translation, like `<1>`, `</1>`, `<2/>`. */
  missing: string[]
  /** Tags in the translation that the source does not have. */
  extra: string[]
  /** Pairs that are not properly nested or closed in the translation. */
  misnested: boolean
}

export function formatTag(t: TagToken): string {
  return t.type === 'open' ? `<${t.n}>` : t.type === 'close' ? `</${t.n}>` : `<${t.n}/>`
}

/** Checks that a translation has exactly the placeholder tags of its source (same multiset) and that the pairs nest. */
export function validateTags(source: string, translated: string): TagCheck {
  const counts = new Map<string, { tok: TagToken; n: number }>()
  for (const t of tagTokens(source)) {
    const e = counts.get(key(t)) ?? { tok: t, n: 0 }
    e.n++
    counts.set(key(t), e)
  }
  const extra: string[] = []
  const tr = tagTokens(translated)
  for (const t of tr) {
    const e = counts.get(key(t))
    if (e && e.n > 0) e.n--
    else extra.push(formatTag(t))
  }
  const missing: string[] = []
  for (const e of counts.values()) for (let i = 0; i < e.n; i++) missing.push(formatTag(e.tok))
  const misnested = !isNested(tr)
  return { ok: missing.length === 0 && extra.length === 0 && !misnested, missing, extra, misnested }
}

function isNested(tokens: TagToken[]): boolean {
  const stack: number[] = []
  for (const t of tokens) {
    if (t.type === 'open') stack.push(t.n)
    else if (t.type === 'close') {
      if (stack.pop() !== t.n) return false
    }
  }
  return stack.length === 0
}

/** Removes the placeholder tags, leaving the plain text. */
export function stripTags(text: string): string {
  return text.replace(TAG_RE, (m, a: string, _n: string, b: string) => (a === '/' && b === '/' ? m : ''))
}
