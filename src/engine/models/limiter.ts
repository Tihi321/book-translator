import type { ProviderInfo } from './registry'

/** The UTC day of a time, `YYYY-MM-DD`: daily request limits (OpenRouter's) start again at midnight UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Per-provider concurrency (semaphore), requests-per-minute and requests-per-day limits. */
export class ProviderLimiter {
  private active = new Map<string, number>()
  private waiters = new Map<string, (() => void)[]>()
  private starts = new Map<string, number[]>()
  /** Requests per provider on one UTC day, and whether the provider said its daily limit is used up. */
  private days = new Map<string, { day: string; n: number; full: boolean }>()

  constructor(private readonly now: () => number = Date.now) {}

  inFlight(providerId: string): number {
    return this.active.get(providerId) ?? 0
  }

  hasCapacity(p: ProviderInfo): boolean {
    return this.inFlight(p.id) < p.concurrency && this.rpmWaitMs(p) === 0 && !this.dayFull(p)
  }

  /** Takes a slot if one is free. */
  tryAcquire(p: ProviderInfo): boolean {
    if (this.inFlight(p.id) >= p.concurrency) return false
    this.active.set(p.id, this.inFlight(p.id) + 1)
    return true
  }

  /** Waits for a slot. */
  async acquire(p: ProviderInfo, signal?: AbortSignal): Promise<void> {
    while (!this.tryAcquire(p)) {
      await new Promise<void>((resolve, reject) => {
        const list = this.waiters.get(p.id) ?? []
        const wake = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          this.waiters.set(p.id, (this.waiters.get(p.id) ?? []).filter((w) => w !== wake))
          const e = new Error('The operation was aborted')
          e.name = 'AbortError'
          reject(e)
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        list.push(wake)
        this.waiters.set(p.id, list)
      })
    }
  }

  release(p: ProviderInfo): void {
    this.active.set(p.id, Math.max(0, this.inFlight(p.id) - 1))
    const next = this.waiters.get(p.id)?.shift()
    next?.()
  }

  /** Wakes every request waiting for a slot of this provider, after its concurrency went up. Those that still don't fit wait again. */
  wakeAll(p: ProviderInfo): void {
    const list = this.waiters.get(p.id) ?? []
    this.waiters.set(p.id, [])
    for (const w of list) w()
  }

  /** Milliseconds to wait before another request fits in the rpm window. 0 when it fits now. */
  rpmWaitMs(p: ProviderInfo): number {
    if (!p.rpm) return 0
    const t = this.now()
    const list = (this.starts.get(p.id) ?? []).filter((s) => t - s < 60_000)
    this.starts.set(p.id, list)
    if (list.length < p.rpm) return 0
    return 60_000 - (t - list[0]!)
  }

  noteRequest(p: ProviderInfo): void {
    const list = this.starts.get(p.id) ?? []
    list.push(this.now())
    this.starts.set(p.id, list)
    this.today(p.id).n++
  }

  /** This UTC day's entry of a provider, started again after midnight UTC. */
  private today(providerId: string): { day: string; n: number; full: boolean } {
    const day = utcDay(this.now())
    let e = this.days.get(providerId)
    if (!e || e.day !== day) this.days.set(providerId, (e = { day, n: 0, full: false }))
    return e
  }

  /** Requests sent to the provider since midnight UTC. */
  requestsToday(providerId: string): number {
    return this.today(providerId).n
  }

  /** The provider reached its requests per day (`rpd`), or said its daily limit is used up: skip it until midnight UTC. */
  dayFull(p: ProviderInfo): boolean {
    const e = this.today(p.id)
    return e.full || (!!p.rpd && e.n >= p.rpd)
  }

  /** The provider answered that its daily limit is used up (OpenRouter's `free-models-per-day`). True when that is news. */
  markDayFull(p: ProviderInfo): boolean {
    const e = this.today(p.id)
    if (e.full) return false
    e.full = true
    return true
  }

  /** When the daily counts start again: the next midnight UTC, as epoch milliseconds. */
  dayResetsAt(): number {
    const d = new Date(this.now())
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  }
}
