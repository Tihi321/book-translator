import { IN_PROGRESS_STATES } from '../shared/project'
import type { ChunkRecord } from '../shared/project'

/** Chunks and blocks an export would leave in the source language. */
export interface UntranslatedReport {
  /** Distinct blocks of the chunks that have no translation (a split block counts once, and only when a part is missing). */
  blocks: number
  failed: { index: number; error?: string }[]
  pending: number[]
  running: number[]
}

type ChunkLike = Pick<ChunkRecord, 'index' | 'state' | 'error' | 'segments' | 'final'>

/** Which blocks of these chunks have no translation, and which chunks are to blame. `translations` is the map `EngineService.translations` returns. */
export function untranslatedReport(chunks: readonly ChunkLike[], translations: ReadonlyMap<string, string>): UntranslatedReport {
  const missing = new Set<string>()
  const report: UntranslatedReport = { blocks: 0, failed: [], pending: [], running: [] }
  for (const chunk of chunks) {
    let has = false
    for (const seg of chunk.segments) {
      if (translations.has(seg.blockId)) continue
      missing.add(seg.blockId)
      has = true
    }
    if (!has && (chunk.state === 'done' || chunk.state === 'flagged')) continue
    if (chunk.state === 'failed') report.failed.push({ index: chunk.index, error: chunk.error })
    else if (IN_PROGRESS_STATES.includes(chunk.state)) report.running.push(chunk.index)
    else report.pending.push(chunk.index)
  }
  report.blocks = missing.size
  return report
}

const CAP = 20

const list = (indexes: readonly number[]): string => {
  const shown = indexes.slice(0, CAP).join(', ')
  return indexes.length > CAP ? `${shown} and ${indexes.length - CAP} more` : shown
}

const plural = (n: number) => (n === 1 ? 'chunk' : 'chunks')

/** `chunk 3 failed; chunks 4, 5 pending`, with `withErrors` each failed chunk on its own with its error. */
function describe(r: UntranslatedReport, withErrors: boolean): string {
  const parts: string[] = []
  if (r.failed.length > 0) {
    if (withErrors) {
      const shown = r.failed.slice(0, CAP).map((f) => `chunk ${f.index} failed${f.error ? ` (${f.error.length > 160 ? `${f.error.slice(0, 160)}...` : f.error})` : ''}`)
      if (r.failed.length > CAP) shown.push(`and ${r.failed.length - CAP} more failed`)
      parts.push(shown.join('; '))
    } else parts.push(`${plural(r.failed.length)} ${list(r.failed.map((f) => f.index))} failed`)
  }
  if (r.running.length > 0) parts.push(`${plural(r.running.length)} ${list(r.running)} in progress`)
  if (r.pending.length > 0) parts.push(`${plural(r.pending.length)} ${list(r.pending)} pending`)
  return parts.join('; ')
}

/** The refusal message of an export with untranslated blocks (starts with `prefix`). */
export function formatRefusal(prefix: string, r: UntranslatedReport): string {
  return `${prefix} ${r.blocks} block(s) would stay in the source language: ${describe(r, true)}. Retry a failed chunk with retry_chunk (optionally with model: another model), finish the run with start_translation, or export with allowPartial: true.`
}

/** The refusal when no chunk exists yet. */
export function formatNothingTranslated(prefix: string, blocks: number): string {
  return `${prefix} nothing is translated yet (${blocks} block(s)). Start the translation (start_translation or prepare_chunks) first, or export with allowPartial: true.`
}

/** The warning of an export that went ahead with untranslated blocks. */
export function formatWarning(r: UntranslatedReport): string {
  return `${r.blocks} block(s) stay in the source language: ${describe(r, false)}`
}
