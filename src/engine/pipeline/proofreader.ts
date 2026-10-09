import { validateTags } from '../formats/inline'
import type { SegmentRec } from '../../shared/project'
import type { AgentEnv } from './env'
import { formatEntries, relevantEntries } from './glossary'
import { buildMessages } from './prompts'
import { describeParse, formatSegments, parseSegments } from './segments'
import { fitEdges } from './translator'

export interface ProofreadResult {
  /** Per segment, the proofread text (the translator's text where the proofreader's was not usable). */
  proofread: Record<string, string>
  changed: number
}

/** The proofreader must not add or drop content: a segment whose length changes a lot is kept as the translator wrote it. */
const MIN_RATIO = 0.6
const MAX_RATIO = 1.6

/**
 * Fluency pass over the translation, with the source for reference. Never fails the chunk: if the reply does not parse, or a segment
 * loses its tags or changes size too much, the translator's text is kept for it.
 */
export async function proofreadChunk(
  env: AgentEnv,
  segs: readonly SegmentRec[],
  translation: Record<string, string>,
  opts: { unit: string; onDelta?: (text: string) => void }
): Promise<ProofreadResult> {
  const keep = { proofread: { ...translation }, changed: 0 }
  const gl = relevantEntries(env.glossary, segs.map((s) => s.text).join('\n'))
  const user = [
    gl.length > 0 ? `## Glossary (keep these translations)\n${formatEntries(gl)}` : '',
    `## Source ${env.sourceLanguage} text (for reference only, do not output it)\n${formatSegments(segs, 'src')}`,
    `## ${env.targetLanguage} translation to proofread\n${formatSegments(segs.map((s) => ({ id: s.id, text: translation[s.id] ?? '' })))}`
  ]
    .filter(Boolean)
    .join('\n\n')
  const messages = await buildMessages(env.dataDir, 'proofreader', { sourceLanguage: env.sourceLanguage, targetLanguage: env.targetLanguage, brief: env.brief }, user)
  const r = await env.call('proofreader', { messages, temperature: 0.2, task: 'proofread', unit: opts.unit }, { onDelta: opts.onDelta })
  const p = parseSegments(r.text, segs.map((s) => s.id))
  if (!p.ok) {
    env.log('warn', `${opts.unit}: proofreader reply unusable (${describeParse(p)}), keeping the translation`)
    return keep
  }
  for (const s of segs) {
    const before = translation[s.id] ?? ''
    const after = fitEdges(s.text, p.segments.get(s.id)!)
    const ratio = after.length / Math.max(1, before.length)
    if (!validateTags(s.text, after).ok || ratio < MIN_RATIO || ratio > MAX_RATIO) {
      env.log('warn', `${opts.unit}: proofreader output for ${s.id} rejected`)
      continue
    }
    if (after !== before) keep.changed++
    keep.proofread[s.id] = after
  }
  return keep
}
