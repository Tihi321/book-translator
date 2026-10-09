import { cleanProse } from './llm'

/** The segment protocol: text goes in as `<seg id="12">text</seg>` and has to come back the same way. */

export interface SegmentInput {
  id: string
  text: string
}

export function formatSegments(segs: readonly SegmentInput[], tag = 'seg'): string {
  return segs.map((s) => `<${tag} id="${s.id}">${s.text}</${tag}>`).join('\n')
}

export interface SegmentParse {
  /** The segments found with an expected id (first one wins for duplicates). */
  segments: Map<string, string>
  /** Expected ids that are absent or empty. */
  missing: string[]
  /** Ids in the reply that were not asked for. */
  extra: string[]
  /** Ids that appear more than once. */
  duplicate: string[]
  /** Every expected id exactly once, and nothing else. */
  ok: boolean
}

/**
 * Reads a reply in the segment format. Tolerates thinking blocks, a code fence around everything, chatter before and after,
 * whitespace and either quote style. Checks every expected id comes back exactly once.
 */
export function parseSegments(reply: string, expectedIds: readonly string[], tag = 'seg'): SegmentParse {
  const text = cleanProse(reply)
  const re = new RegExp(`<${tag}\\s+id\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))\\s*>([\\s\\S]*?)</${tag}\\s*>`, 'g')
  const expected = new Set(expectedIds)
  const found = new Map<string, string>()
  const seen = new Set<string>()
  const extra: string[] = []
  const duplicate: string[] = []
  for (const m of text.matchAll(re)) {
    const id = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (seen.has(id)) {
      if (!duplicate.includes(id)) duplicate.push(id)
      continue
    }
    seen.add(id)
    if (!expected.has(id)) {
      extra.push(id)
      continue
    }
    found.set(id, m[4]!.trim())
  }
  const missing = expectedIds.filter((id) => !(found.get(id)?.length))
  for (const id of missing) found.delete(id)
  return { segments: found, missing, extra, duplicate, ok: missing.length === 0 && extra.length === 0 && duplicate.length === 0 }
}

/** A short description of what is wrong with a reply, for the retry note. */
export function describeParse(p: SegmentParse): string {
  const parts: string[] = []
  if (p.missing.length) parts.push(`missing or empty segments: ${p.missing.join(', ')}`)
  if (p.extra.length) parts.push(`segment ids that were not asked for: ${p.extra.join(', ')}`)
  if (p.duplicate.length) parts.push(`segment ids repeated: ${p.duplicate.join(', ')}`)
  return parts.join('; ') || 'no <seg> elements found'
}
