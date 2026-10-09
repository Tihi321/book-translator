import { z } from 'zod'
import { stripTags, validateTags } from '../formats/inline'
import type { GlossaryEntry, IssueType, QaIssue, SegmentRec } from '../../shared/project'
import { chatFn } from './env'
import type { AgentEnv } from './env'
import { formatEntries, relevantEntries } from './glossary'
import { chatJson } from './llm'
import { buildMessages } from './prompts'
import { describeParse, formatSegments, parseSegments } from './segments'
import { fitEdges } from './translator'

const ISSUE_TYPES: readonly IssueType[] = ['omission', 'addition', 'mistranslation', 'glossary', 'tags', 'untranslated']

/** Below this share of the source length (in characters) a translation looks like it dropped text. */
const MIN_RATIO = 0.4
const MAX_RATIO = 2.5
const MIN_CHARS_FOR_RATIO = 25

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/**
 * Checks that need no model: length ratio outliers, text left untranslated (source == target), glossary term missing in the
 * translation, inline tag mismatch. Glossary misses are minor (inflected languages rarely match exactly), the rest are major
 * except a long translation.
 */
export function deterministicChecks(
  segs: readonly SegmentRec[],
  final: Record<string, string>,
  glossary: readonly GlossaryEntry[],
  opts: { sameLanguage?: boolean } = {}
): QaIssue[] {
  const issues: QaIssue[] = []
  for (const s of segs) {
    const tr = final[s.id]
    if (tr === undefined) continue
    const src = stripTags(s.text).trim()
    const tgt = stripTags(tr).trim()
    const c = validateTags(s.text, tr)
    if (!c.ok) {
      const bits = [c.missing.length ? `missing ${c.missing.join(' ')}` : '', c.extra.length ? `unexpected ${c.extra.join(' ')}` : '', c.misnested ? 'not nested' : ''].filter(Boolean)
      issues.push({ segId: s.id, type: 'tags', severity: 'major', comment: `Inline tags differ from the source (${bits.join(', ')}).` })
    }
    if (!opts.sameLanguage && src && src === tgt && words(src) >= 3 && /\p{L}{2}/u.test(src)) {
      issues.push({ segId: s.id, type: 'untranslated', severity: 'major', comment: 'The translation is identical to the source text.' })
    } else if (src.length >= MIN_CHARS_FOR_RATIO) {
      const ratio = tgt.length / src.length
      if (ratio < MIN_RATIO) issues.push({ segId: s.id, type: 'omission', severity: 'major', comment: `The translation is much shorter than the source (${Math.round(ratio * 100)}% of its length); text may be missing.` })
      else if (ratio > MAX_RATIO) issues.push({ segId: s.id, type: 'addition', severity: 'minor', comment: `The translation is much longer than the source (${Math.round(ratio * 100)}% of its length); text may have been added.` })
    }
    for (const g of relevantEntries(glossary, s.text)) {
      if (!tgt.toLowerCase().includes(g.target.toLowerCase())) {
        issues.push({ segId: s.id, type: 'glossary', severity: 'minor', comment: `Glossary term "${g.source}" should be "${g.target}", which is not in the translation.`, suggestion: g.target })
      }
    }
  }
  return issues
}

const str = z.string().optional()
export const qaReplySchema = z.object({
  issues: z.array(z.object({ segId: z.union([z.string(), z.number()]), type: str, severity: str, comment: str, suggestion: str })).default([])
})

function sameIssue(a: QaIssue, b: QaIssue): boolean {
  return a.segId === b.segId && a.type === b.type
}

/** Deterministic checks, then the QA model. A QA model that cannot answer (bad JSON twice) does not stop the chunk: its part is skipped with a warning. */
export async function reviewChunk(
  env: AgentEnv,
  segs: readonly SegmentRec[],
  final: Record<string, string>,
  opts: { unit: string; task?: string }
): Promise<QaIssue[]> {
  const issues = deterministicChecks(segs, final, env.glossary, { sameLanguage: env.sourceLanguage.toLowerCase() === env.targetLanguage.toLowerCase() })
  const ids = new Set(segs.map((s) => s.id))
  const gl = relevantEntries(env.glossary, segs.map((s) => s.text).join('\n'))
  const pairs = segs.map((s) => `<pair id="${s.id}">\n<src>${s.text}</src>\n<tgt>${final[s.id] ?? ''}</tgt>\n</pair>`).join('\n')
  const user = [gl.length > 0 ? `## Glossary\n${formatEntries(gl)}` : '', `## Segments to review\n${pairs}`].filter(Boolean).join('\n\n')
  const messages = await buildMessages(env.dataDir, 'qa', { sourceLanguage: env.sourceLanguage, targetLanguage: env.targetLanguage, brief: env.brief }, user)
  try {
    const { value } = await chatJson(chatFn(env, 'qa', opts.task ?? 'review', opts.unit), messages, qaReplySchema, { temperature: 0.1, signal: env.signal })
    for (const i of value.issues) {
      const segId = String(i.segId).trim()
      if (!ids.has(segId)) continue
      const type = (ISSUE_TYPES as readonly string[]).includes(i.type ?? '') ? (i.type as IssueType) : 'mistranslation'
      const issue: QaIssue = { segId, type, severity: i.severity === 'major' ? 'major' : 'minor', comment: i.comment?.trim() || type }
      if (i.suggestion?.trim()) issue.suggestion = i.suggestion.trim()
      if (!issues.some((x) => sameIssue(x, issue))) issues.push(issue)
    }
  } catch (err) {
    if (env.signal?.aborted || (err as Error).name === 'AbortError') throw err
    env.log('warn', `${opts.unit}: QA model gave no usable answer (${(err as Error).message}); deterministic checks only`)
  }
  return issues
}

/**
 * The fix pass: the translator models get the issues as feedback for the affected segments only. Returns the new text for the segments
 * it could fix (reply parsed and tags intact); the others are left out so the caller keeps what it had.
 */
export async function fixChunk(
  env: AgentEnv,
  segs: readonly SegmentRec[],
  final: Record<string, string>,
  issues: readonly QaIssue[],
  opts: { unit: string; onDelta?: (text: string) => void }
): Promise<Record<string, string>> {
  const affected = segs.filter((s) => issues.some((i) => i.segId === s.id))
  if (affected.length === 0) return {}
  const feedback = issues
    .filter((i) => affected.some((s) => s.id === i.segId))
    .map((i) => `- ${i.segId} [${i.severity} ${i.type}]: ${i.comment}${i.suggestion ? ` Suggestion: ${i.suggestion}` : ''}`)
    .join('\n')
  const gl = relevantEntries(env.glossary, affected.map((s) => s.text).join('\n'))
  const user = [
    gl.length > 0 ? `## Glossary\n${formatEntries(gl)}` : '',
    `## Problems found by the reviewer\n${feedback}`,
    `## Source ${env.sourceLanguage} text\n${formatSegments(affected, 'src')}`,
    `## Current ${env.targetLanguage} translation\n${formatSegments(affected.map((s) => ({ id: s.id, text: final[s.id] ?? '' })), 'cur')}`
  ]
    .filter(Boolean)
    .join('\n\n')
  const messages = await buildMessages(env.dataDir, 'fix', { sourceLanguage: env.sourceLanguage, targetLanguage: env.targetLanguage, brief: env.brief }, user)
  const r = await env.call('translator', { messages, temperature: 0.3, task: 'fix', unit: opts.unit }, { onDelta: opts.onDelta })
  const p = parseSegments(r.text, affected.map((s) => s.id))
  if (p.segments.size === 0) env.log('warn', `${opts.unit}: fix reply unusable (${describeParse(p)})`)
  const out: Record<string, string> = {}
  for (const s of affected) {
    const text = p.segments.get(s.id)
    if (text === undefined) continue
    const fitted = fitEdges(s.text, text)
    if (validateTags(s.text, fitted).ok) out[s.id] = fitted
  }
  return out
}
