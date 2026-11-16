import { validateTags, stripTags } from '../formats/inline'
import type { QaIssue, SegmentRec } from '../../shared/project'
import { ChunkFailure } from './env'
import type { AgentEnv } from './env'
import { formatEntries, relevantEntries } from './glossary'
import { buildMessages } from './prompts'
import { describeParse, formatSegments, parseSegments, salvage } from './segments'

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

/** The user message of a translator request: glossary slice, previous passage, a note about the last answer, the segments. */
export function translatorUserContent(
  env: Pick<AgentEnv, 'glossary' | 'targetLanguage'>,
  segs: readonly SegmentRec[],
  prev: PrevContext | undefined,
  note: string | undefined,
  /** `rule`: the brief's typography rule. `previousMissing`: the number of the chunk before this one when it is not translated yet. `next`: the passage after the segments (a re-ask). */
  style: { rule?: string; previousMissing?: number; next?: PrevContext } = {}
): string {
  const parts: string[] = []
  const gl = relevantEntries(env.glossary, segs.map((s) => s.text).join('\n'))
  if (gl.length > 0) parts.push(`## Glossary (use these translations)\n${formatEntries(gl)}`)
  const rule = style.rule ? `\n\n${style.rule}` : ''
  if (prev) parts.push(`## Previous passage (context only, do not translate it)\nSource:\n${prev.source}\n\nTranslation:\n${prev.translation}${rule}`)
  else if (style.previousMissing !== undefined)
    parts.push(`## Previous passage\nNone: chunk ${style.previousMissing} is not translated yet (another translator may be working on it), so there is no earlier translation to match. Follow the glossary and the brief for names, wording and typography.${rule}`)
  if (style.next) parts.push(`## Following passage (context only, do not translate it)
Source:
${style.next.source}

Translation:
${style.next.translation}`)
  if (note) parts.push(`## Problem with your previous answer\n${note}`)
  parts.push(`## Translate these segments into ${env.targetLanguage}\n${formatSegments(segs)}`)
  return parts.join('\n\n')
}

/** One request for a set of segments. Returns the parse of the reply. */
async function ask(env: AgentEnv, segs: readonly SegmentRec[], opts: TranslateOptions, note: string | undefined, task: string, skipModels: readonly string[] = [], ctx?: { prev?: PrevContext; next?: PrevContext }) {
  const messages = await buildMessages(
    env.dataDir,
    'translator',
    { sourceLanguage: env.sourceLanguage, targetLanguage: env.targetLanguage, brief: env.brief },
    translatorUserContent(env, segs, ctx ? ctx.prev : opts.prev, note, ctx?.next ? { next: ctx.next } : {})
  )
  const r = await env.call('translator', { messages, temperature: 0.3, task, unit: opts.unit, ...(skipModels.length > 0 ? { skipModels } : {}) }, { onDelta: opts.onDelta })
  return { parse: parseSegments(r.text, segs.map((s) => s.id)), model: r.model }
}

/** The inline-tag problem of a translated segment, if it has one. */
export function tagIssue(seg: SegmentRec, text: string): QaIssue | undefined {
  const c = validateTags(seg.text, text)
  if (c.ok) return undefined
  const bits = [c.missing.length ? `missing ${c.missing.join(' ')}` : '', c.extra.length ? `unexpected ${c.extra.join(' ')}` : '', c.misnested ? 'tags not nested' : ''].filter(Boolean)
  return { segId: seg.id, type: 'tags', severity: 'major', comment: `Inline tags do not match the source (${bits.join(', ')}); plain text kept.` }
}

/** Calls on one model (the first, then a retry with a note) before the next model of the project's list is tried. */
const MISMATCHES_PER_MODEL = 2

/** Follow-up calls per salvaged full reply that ask the same model for the missing ids only. */
const MAX_REASKS = 2

/**
 * Translates the segments of a chunk. A reply that misses or garbles a few ids (no ids that were not asked for) keeps the rest, and up to
 * MAX_REASKS small calls ask the same model for the missing ones only, with the passages around them; only if that fails is the whole chunk asked again.
 * A reply that does not have exactly the asked ids is retried once with a note; if that fails too,
 * the next model of the project's own translator list is asked (a fresh call, then one retry), and so on. Only when every model of the
 * list failed twice is the chunk split in half, each half tried again from the head of the list; if that fails too, throws ChunkFailure. Per segment, inline tags must match
 * the source: one retry for the segments that do not, then the plain text is kept and a `tags` issue recorded.
 * Segments that were already translated before a failure or a pause are in `out` (an optional shared record): they are not asked for
 * again, and a kept segment whose tags do not match the source gets its `tags` issue again.
 */
export async function translateChunk(env: AgentEnv, segs: readonly SegmentRec[], opts: TranslateOptions, out: Record<string, string> = {}): Promise<TranslateResult> {
  const issues: QaIssue[] = []
  const kept = (s: SegmentRec) => Object.hasOwn(out, s.id)
  for (const s of segs) {
    const issue = kept(s) ? tagIssue(s, out[s.id]!) : undefined
    if (issue) issues.push(issue)
  }

  const accept = async (group: readonly SegmentRec[], got: Map<string, string>, failed: readonly string[]) => {
    const bad: SegmentRec[] = []
    const first = new Map<string, string>() // a segment with bad tags is stored only once settled: a stop in between asks for it again
    for (const s of group) {
      const text = fitEdges(s.text, got.get(s.id)!)
      if (tagIssue(s, text)) {
        bad.push(s)
        first.set(s.id, text)
      } else out[s.id] = text
    }
    if (bad.length === 0) return
    let retry: Map<string, string> | undefined
    try {
      const note = `The inline tags (<1>, </1>, <2/> ...) must be copied exactly as in the source segment. Problems: ${bad.map((s) => `${s.id}: ${tagIssue(s, first.get(s.id)!)!.comment}`).join(' ')}`
      const { parse: p } = await ask(env, bad, opts, note, 'retry-tags', failed)
      if (p.ok) retry = p.segments
    } catch (err) {
      if (env.signal?.aborted || (err as Error).name === 'AbortError') throw err
    }
    for (const s of bad) {
      const text = retry ? fitEdges(s.text, retry.get(s.id)!) : first.get(s.id)!
      const issue = tagIssue(s, text)
      if (!issue) out[s.id] = text
      else {
        out[s.id] = stripTags(text)
        issues.push(issue)
      }
    }
  }

  /** Keeps the good segments of a failed reply and asks the same model for the missing or garbled ones only. Undefined when it cannot fill the group. */
  const reask = async (group: readonly SegmentRec[], p: ReturnType<typeof parseSegments>, model: string, failed: readonly string[]): Promise<Map<string, string> | undefined> => {
    const s = salvage(p, group.map((g) => g.id))
    if (!s) return undefined
    const merged = new Map(s.keep)
    let todo = s.ask
    if (todo.length === 0) {
      env.log('warn', `${opts.unit}: identical repeated segment(s) ignored: ${p.duplicate.join(', ')}`)
      return merged
    }
    const note = `Your previous answer had problems (${describeParse(p)}). The other segments are done. Translate only the segments below, which come between the passages above and below. Return each exactly once in its own seg element with the same id.`
    try {
      for (let i = 0; i < MAX_REASKS && todo.length > 0; i++) {
        env.log('warn', `${opts.unit}: asking ${model} again for ${todo.length} segment(s) only: ${todo.join(', ')}`)
        const askSegs = group.filter((g) => todo.includes(g.id))
        const at = group.indexOf(askSegs[0]!)
        const after = group[group.indexOf(askSegs[askSegs.length - 1]!) + 1]
        const prev = at === 0 ? opts.prev : prevTail(group.slice(Math.max(0, at - 2), at), Object.fromEntries(merged))
        const next = after && merged.has(after.id) ? { source: after.text, translation: merged.get(after.id)! } : undefined
        const { parse: q } = await ask(env, askSegs, opts, note, 'reask', failed, { prev, next })
        if (q.extra.length === 0) for (const [id, text] of q.segments) if (!q.conflicting.includes(id)) merged.set(id, text)
        todo = todo.filter((id) => !merged.has(id))
      }
    } catch (err) {
      if (env.signal?.aborted || (err as Error).name === 'AbortError') throw err
      env.log('warn', `${opts.unit}: the re-ask failed (${(err as Error).message})`)
    }
    if (todo.length === 0) {
      env.log('info', `${opts.unit}: the re-ask filled the chunk`)
      return merged
    }
    env.log('warn', `${opts.unit}: the re-ask left ${todo.join(', ')}; asking for the whole chunk again`)
    return undefined
  }

  const attempt = async (group: readonly SegmentRec[], canSplit: boolean): Promise<void> => {
    let note: string | undefined
    const failed: string[] = [] // models that returned a wrong set of segments MISMATCHES_PER_MODEL times
    let count = 0
    let current: string | undefined
    for (;;) {
      const { parse: p, model } = await ask(env, group, opts, note, count === 0 ? 'translate' : 'retry', failed)
      if (p.ok) return accept(group, p.segments, failed)
      env.log('warn', `${opts.unit}: segment mismatch on ${model} (${describeParse(p)})`)
      const merged = await reask(group, p, model, failed)
      if (merged) return accept(group, merged, failed)
      note = `${describeParse(p)}. Return every segment exactly once, each in its own seg element with the same id, and nothing else.`
      if (model !== current) {
        count = 0
        current = model
      }
      count++
      if (count < MISMATCHES_PER_MODEL) continue
      failed.push(model)
      const left = (env.models?.('translator') ?? [model]).filter((m) => !failed.includes(m))
      if (left.length === 0) break
      env.log('warn', `${opts.unit}: segment mismatch ${MISMATCHES_PER_MODEL} times on ${model}, trying ${left[0]}`)
      count = 0
      note = undefined
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

  const todo = segs.filter((s) => !kept(s))
  if (todo.length > 0) await attempt(todo, true)
  return { translation: { ...out }, issues }
}
