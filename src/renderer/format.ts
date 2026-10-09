import type { ChunkState } from '../shared/project'

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '?'
  if (sec < 90) return `${Math.max(0, Math.round(sec))}s`
  if (sec < 5400) return `${Math.round(sec / 60)} min`
  return `${(sec / 3600).toFixed(1)} h`
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '$0'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function fmtContext(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}k`
}

/** The model name without the provider. */
export const modelName = (ref: string | undefined) => (ref ? ref.slice(ref.indexOf('/') + 1) : '')

export const STATE_LABEL: Record<ChunkState, string> = {
  pending: 'pending',
  translating: 'translating',
  proofreading: 'proofreading',
  reviewing: 'reviewing',
  fixing: 'fixing',
  done: 'done',
  flagged: 'flagged',
  failed: 'failed'
}
