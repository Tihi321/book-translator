import { validateTags, stripTags } from '../formats/inline'
import type { QaIssue, SegmentRec } from '../../shared/project'
import { ChunkFailure } from './env'
import type { AgentEnv } from './env'
import { formatEntries, relevantEntries } from './glossary'
import { buildMessages } from './prompts'
import { describeParse, formatSegments, parseSegments } from './segments'

export interface PrevContext {
  /** Source text of the last blocks of the previous chunk. */
  source: string
  /** Their translation. */
  translation: string
}

export interface TranslateOptions {
  prev?: PrevContext
  unit: string
  onDelta?: (text: string) => void
}

export interface TranslateResult {
  translation: Record<string, string>
  issues: QaIssue[]
}

const MAX_PREV_CHARS = 1200

/** The last ~2 blocks of a finished chunk, as source and translation. */
export function prevTail(segments: readonly SegmentRec[], final: Record<string, string>, blocks = 2): PrevContext | undefined {
  const done = segments.filter((s) => final[s.id] !== undefined)
  if (done.length === 0) return undefined
  const ids: string[] = []
  for (let i = done.length - 1; i >= 0 && ids.length < blocks; i--) if (!ids.includes(done[i]!.blockId)) ids.unshift(done[i]!.blockId)
  const pick = done.filter((s) => ids.includes(s.blockId))
  const join = (xs: string[]) => {
    const t = xs.join('\n\n')
    return t.length > MAX_PREV_CHARS ? '...' + t.slice(-MAX_PREV_CHARS) : t
  }
  return { source: join(pick.map((s) => s.text)), translation: join(pick.map((s) => final[s.id]!)) }
}

/** The model may trim or reflow whitespace: keep the source's leading indentation, drop the rest. */
export function fitEdges(source: string, text: string): string {
  const lead = /^[ \t]*/.exec(source)![0]
  return lead + text.trim()
}

function userContent(env: AgentEnv, segs: readonly SegmentRec[], prev: PrevContext | undefined, note: string | undefined): string {
  const parts: string[] = []
  const gl = relevantEntries(env.glossary, segs.map((s) => s.text).join('\n'))
  if (gl.length > 0) parts.push(`## Glossary (use these translations)\n${formatEntries(gl)}`)
  if (prev) parts.push(`## Previous passage (context only, do not translate it)\nSource:\n${prev.source}\n\nTranslation:\n${prev.translation}`)
  if (note) parts.push(`## Problem with your previous answer\n${note}`)
  parts.push(`## Translate these segments into ${env.targetLanguage}\n${formatSegments(segs)}`)
  return parts.join('\n\n')
}

/** One request for a set of segments. Returns the parse of the reply. */
async function ask(env: AgentEnv, segs: readonly SegmentRec[], opts: TranslateOptions, note: string | undefined, task: string) {
  const messages = await buildMessages(
    env.dataDir,
    'translator',
    { sourceLanguage: env.sourceLanguage, targetLanguage: env.targetLanguage, brief: env.brief },
    userContent(env, segs, opts.prev, note)
  )
  const r = await env.call('translator', { messages, temperature: 0.3, task, unit: opts.unit }, { onDelta: opts.onDelta })
  return parseSegments(r.text, segs.map((s) => s.id))
}

function tagIssue(seg: SegmentRec, text: string): QaIssue | undefined {
  const c = validateTags(seg.text, text)
  if (c.ok) return undefined
  const bits = [c.missing.length ? `missing ${c.missing.join(' ')}` : '', c.extra.length ? `unexpected ${c.extra.join(' ')}` : '', c.misnested ? 'tags not nested' : ''].filter(Boolean)
  return { segId: seg.id, type: 'tags', severity: 'major', comment: `Inline tags do not match the source (${bits.join(', ')}); plain text kept.` }
}

/**
 * Translates the segments of a chunk. A reply that does not have exactly the asked ids is retried once with a note, then the chunk is
 * split in half and each half tried (again with one retry); if that fails too, throws ChunkFailure. Per segment, inline tags must match
 * the source: one retry for the segments that do not, then the plain text is kept and a `tags` issue recorded.
 * Segments that were already translated before a failure are in `out` (an optional shared record).
 */
export async function translateChunk(env: AgentEnv, segs: readonly SegmentRec[], opts: TranslateOptions, out: Record<string, string> = {}): Promise<TranslateResult> {
  const issues: QaIssue[] = []

  const accept = async (group: readonly SegmentRec[], got: Map<string, string>) => {
    const bad: SegmentRec[] = []
    for (const s of group) {
      const text = fitEdges(s.text, got.get(s.id)!)
      out[s.id] = text
      if (tagIssue(s, text)) bad.push(s)
    }
    if (bad.length === 0) return
    let retry: Map<string, string> | undefined
    try {
      const note = `The inline tags (<1>, </1>, <2/> ...) must be copied exactly as in the source segment. Problems: ${bad.map((s) => `${s.id}: ${tagIssue(s, out[s.id]!)!.comment}`).join(' ')}`
      const p = await ask(env, bad, opts, note, 'retry-tags')
      if (p.ok) retry = p.segments
    } catch (err) {
      if (env.signal?.aborted || (err as Error).name === 'AbortError') throw err
    }
    for (const s of bad) {
      const text = retry ? fitEdges(s.text, retry.get(s.id)!) : out[s.id]!
      const issue = tagIssue(s, text)
      if (!issue) out[s.id] = text
      else {
        out[s.id] = stripTags(text)
        issues.push(issue)
      }
    }
  }

  const attempt = async (group: readonly SegmentRec[], canSplit: boolean): Promise<void> => {
    let note: string | undefined
    for (let n = 0; n < 2; n++) {
      const p = await ask(env, group, opts, note, n === 0 ? 'translate' : 'retry')
      if (p.ok) return accept(group, p.segments)
      note = `${describeParse(p)}. Return every segment exactly once, each in its own seg element with the same id, and nothing else.`
      env.log('warn', `${opts.unit}: segment mismatch (${describeParse(p)})`)
    }
    if (canSplit && group.length > 1) {
      env.log('warn', `${opts.unit}: splitting the chunk in two`)
      const mid = Math.ceil(group.length / 2)
      await attempt(group.slice(0, mid), false)
      await attempt(group.slice(mid), false)
      return
    }
    throw new ChunkFailure(`${opts.unit}: the model did not return the segments correctly (${note})`)
  }

  await attempt(segs, true)
  return { translation: { ...out }, issues }
}
