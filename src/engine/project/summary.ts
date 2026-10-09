import { CHUNK_STATES } from '../../shared/project'
import type { ChunkRecord, ChunkState, ProjectFile, ProjectSummary } from '../../shared/project'

export function countStates(chunks: readonly ChunkRecord[]): Record<ChunkState, number> {
  const counts = Object.fromEntries(CHUNK_STATES.map((s) => [s, 0])) as Record<ChunkState, number>
  for (const c of chunks) counts[c.state]++
  return counts
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
    spend: p.spend
  }
}
