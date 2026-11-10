import { z } from 'zod'
import { stripTags, textOutsideTags, validateTags } from '../formats/inline'
import { vnPackSegmentProblem } from '../formats/vnPack'
import type { DocFormat } from '../../shared/ir'
import type { GlossaryEntry, IssueType, QaIssue, SegmentRec } from '../../shared/project'
import { chatFn, ClientOnlyRefusal } from './env'
import type { AgentEnv } from './env'
import { formatEntries, hasTarget, normalizeTerm, relevantEntries } from './glossary'
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

const LINK_RE = /(?:https?:\/\/|www\.)\S+|\bdoi:\s*\S+|\bisbn(?:-1[03])?:?\s*[\d-]+x?/giu
/** An author-year entry of a reference list: `Surname, A. B. (2019). Title ...`. */
const REFERENCE_RE = /^\s*\p{Lu}[\p{L}'’-]+,\s*(?:\p{Lu}\.\s*)+.*\b(?:1[5-9]|20)\d{2}[a-z]?\b/su

/** A segment that is mostly a link or a reference-list entry: its titles stay in the source language on purpose, so glossary terms are not checked in it. */
export function isCitation(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const linkChars = (t.match(LINK_RE) ?? []).reduce((n, m) => n + m.length, 0)
  return linkChars / t.length >= 0.25 || REFERENCE_RE.test(t)
}

/**
 * True when the text is long enough to count as left untranslated. Only the words outside inline tags count (a speaker tag
 * like `<1>INÈS (angry):</1>` is not text), and the terms of glossary rows kept as they are (source == target) do not count either.
 * A line made only of tagged text counts in full. The brief's free-text "kept as is" rules are not parsed: use a keep row in the glossary.
 */
function looksUntranslated(srcRaw: string, src: string, glossary: readonly GlossaryEntry[]): boolean {
  if (!/\p{L}{2}/u.test(src)) return false
  let body = textOutsideTags(srcRaw).trim() || src
  for (const e of glossary) {
    const t = e.source.trim()
    if (t && normalizeTerm(e.source) === normalizeTerm(e.target)) body = body.split(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')).join(' ')
  }
  return words(body) >= 3
}

/**
 * Checks that need no model: length ratio outliers, text left untranslated (source == target), glossary term missing in the
 * translation, inline tag mismatch. Glossary misses are minor (inflected languages rarely match exactly), the rest are major
 * except a long translation. A visual-novel pack's catalog values (`format: 'vnp'`) also have to stay one line, non-empty and free of
 * structural labels and ids (the contract's §5 rules), which a model likes to add.
 */
export function deterministicChecks(
  segs: readonly SegmentRec[],
  final: Record<string, string>,
  glossary: readonly GlossaryEntry[],
  opts: { sameLanguage?: boolean; format?: DocFormat } = {}
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
    if (opts.format === 'vnp') {
      const problem = vnPackSegmentProblem(s.text, tr)
      if (problem) issues.push({ segId: s.id, type: 'mistranslation', severity: 'major', comment: `This is a visual-novel catalog value: it ${problem}. Keep it one non-empty line, with no structural label (SCENE:, ON SCREEN: ...) and no scene or beat id.` })
    }
    if (!opts.sameLanguage && !(opts.format === 'vnp' && s.id.startsWith('char.')) && src && src === tgt && looksUntranslated(s.text, src, glossary)) {
      issues.push({ segId: s.id, type: 'untranslated', severity: 'major', comment: 'The translation is identical to the source text.' })
    } else if (src.length >= MIN_CHARS_FOR_RATIO) {
      const ratio = tgt.length / src.length
      if (ratio < MIN_RATIO) issues.push({ segId: s.id, type: 'omission', severity: 'major', comment: `The translation is much shorter than the source (${Math.round(ratio * 100)}% of its length); text may be missing.` })
      else if (ratio > MAX_RATIO) issues.push({ segId: s.id, type: 'addition', severity: 'minor', comment: `The translation is much longer than the source (${Math.round(ratio * 100)}% of its length); text may have been added.` })
    }
    for (const g of isCitation(s.text) ? [] : relevantEntries(glossary, s.text)) {
      if (!hasTarget(tgt, g.target)) {
        issues.push({ segId: s.id, type: 'glossary', severity: 'minor', comment: `Glossary term "${g.source}" should be "${g.target}", which is not in the translation.`, suggestion: g.target })
      }
    }
  }
  return issues
}

const str = z.string().optional()
export const qaReplySchema = z.object({
  /** The reviewer's own grade of the translation, 0 to 10. */
  score: z.union([z.number(), z.string()]).nullish(),
  issues: z.array(z.object({ segId: z.union([z.string(), z.number()]), type: str, severity: str, comment: str, suggestion: str })).default([])
})

/** A finite number clamped to 0..10 with one decimal; anything else is no score. */
export function parseScore(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim().replace(',', '.')) : NaN
  return Number.isFinite(n) ? Math.round(Math.min(10, Math.max(0, n)) * 10) / 10 : undefined
}

/** The grade when the reviewer gave none: 10 minus 3 per major and 1 per minor issue, not below 0. */
export function issueScore(issues: readonly QaIssue[]): number {
  return Math.max(0, 10 - 3 * issues.filter((i) => i.severity === 'major').length - issues.filter((i) => i.severity !== 'major').length)
}

export interface ReviewResult {
  issues: QaIssue[]
  /** Absent when the QA model gave no usable answer. */
  score?: number
  /** The model that gave the verdict. */
  model?: string
  /** Why the QA model was refused (a hand-edited reviewer a client-only project may not call); the chunk is flagged. */
  refused?: string
}

function sameIssue(a: QaIssue, b: QaIssue): boolean {
  return a.segId === b.segId && a.type === b.type
}

/** Deterministic checks, then the QA model. A QA model that cannot answer (bad JSON twice) does not stop the chunk: its part is skipped with a warning. */
export async function reviewChunk(
  env: AgentEnv,
  segs: readonly SegmentRec[],
  final: Record<string, string>,
  opts: { unit: string; task?: string }
): Promise<ReviewResult> {
  const issues = deterministicChecks(segs, final, env.glossary, { sameLanguage: env.sourceLanguage.toLowerCase() === env.targetLanguage.toLowerCase(), format: env.format })
  const ids = new Set(segs.map((s) => s.id))
  const gl = relevantEntries(env.glossary, segs.map((s) => s.text).join('\n'))
  const pairs = segs.map((s) => `<pair id="${s.id}">\n<src>${s.text}</src>\n<tgt>${final[s.id] ?? ''}</tgt>\n</pair>`).join('\n')
  const user = [gl.length > 0 ? `## Glossary\n${formatEntries(gl)}` : '', `## Segments to review\n${pairs}`].filter(Boolean).join('\n\n')
  const messages = await buildMessages(env.dataDir, 'qa', { sourceLanguage: env.sourceLanguage, targetLanguage: env.targetLanguage, brief: env.brief }, user)
  // a prompt file from before the score existed: ask for it in the user message
  if (!messages.some((m) => m.content.includes('"score"'))) {
    const last = messages[messages.length - 1]!
    last.content += ['', '', '## Score', 'Also put "score" (your overall grade of this translation, 0 = unusable to 10 = publishable as is) in the JSON object.'].join('\n')
  }
  let score: number | undefined
  let model: string | undefined
  try {
    const { value, reply } = await chatJson(chatFn(env, 'qa', opts.task ?? 'review', opts.unit), messages, qaReplySchema, { temperature: 0.1, signal: env.signal })
    score = parseScore(value.score)
    model = reply.model
    for (const i of value.issues) {
      const segId = String(i.segId).trim()
      if (!ids.has(segId)) continue
      const type = (ISSUE_TYPES as readonly string[]).includes(i.type ?? '') ? (i.type as IssueType) : 'mistranslation'
      // the deterministic check decides on inline tags: a reviewer's "missing tags" on a segment whose tags match the source is a false positive
      if (type === 'tags' && validateTags(segs.find((s) => s.id === segId)!.text, final[segId] ?? '').ok) continue
      const issue: QaIssue = { segId, type, severity: i.severity === 'major' ? 'major' : 'minor', comment: i.comment?.trim() || type }
      if (i.suggestion?.trim()) issue.suggestion = i.suggestion.trim()
      if (!issues.some((x) => sameIssue(x, issue))) issues.push(issue)
    }
  } catch (err) {
    if (env.signal?.aborted || (err as Error).name === 'AbortError') throw err
    env.log('warn', `${opts.unit}: QA model gave no usable answer (${(err as Error).message}); deterministic checks only`)
    return { issues, ...(err instanceof ClientOnlyRefusal ? { refused: err.message } : {}) }
  }
  return { issues, score: score ?? issueScore(issues), ...(model ? { model } : {}) }
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
