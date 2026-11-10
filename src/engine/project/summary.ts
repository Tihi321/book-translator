import { CHUNK_STATES, reviewerAgents } from '../../shared/project'
import type { ChunkRecord, ChunkState, ProjectFile, ProjectSettings, ProjectSummary, QaScore } from '../../shared/project'

export function countStates(chunks: readonly ChunkRecord[]): Record<ChunkState, number> {
  const counts = Object.fromEntries(CHUNK_STATES.map((s) => [s, 0])) as Record<ChunkState, number>
  for (const c of chunks) counts[c.state]++
  return counts
}

/**
 * The project's QA score, from the chunk files: the mean of the chunk scores, who gave them, and whether none was a self-review (the reviewer is not the model that translated the chunk).
 * With the settings, `independent` before any chunk is scored says whether a reviewer is set for QA.
 */
export function qaScoreOf(chunks: readonly ChunkRecord[], settings?: Pick<ProjectSettings, 'clientOnly' | 'reviewer'>): QaScore {
  const scored = chunks.filter((c) => typeof c.qa.score === 'number')
  if (scored.length === 0) return { score: null, scored: 0, models: [], independent: settings !== undefined && reviewerAgents(settings).includes('qa') }
  const mean = scored.reduce((n, c) => n + (c.qa.score as number), 0) / scored.length
  return {
    score: Math.round(mean * 10) / 10,
    scored: scored.length,
    models: [...new Set(scored.map((c) => c.qa.model).filter((m): m is string => !!m))],
    independent: scored.every((c) => c.qa.model !== c.model)
  }
}

/** One line for a status display: `8.7/10 (12 of 14 chunks, acp/x)`, with `self-reviewed` when not independent. */
export function qaScoreLine(qa: QaScore, total: number): string {
  if (qa.score === null) return 'none yet'
  return `${qa.score}/10 (${qa.scored} of ${total} chunks, ${qa.models.join(', ') || 'unknown model'})${qa.independent ? '' : ' self-reviewed'}`
}

export function summarize(p: ProjectFile, chunks: readonly ChunkRecord[]): ProjectSummary {
  const counts = countStates(chunks)
  return {
    id: p.id,
    name: p.name,
    sourcePath: p.sourcePath,
    format: p.format,
    sourceLanguage: p.settings.sourceLanguage,
    targetLanguage: p.settings.targetLanguage,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    chunks: chunks.length,
    done: counts.done + counts.flagged,
    flagged: counts.flagged,
    failed: counts.failed,
    qa: qaScoreOf(chunks, p.settings),
    spend: p.spend
  }
}
