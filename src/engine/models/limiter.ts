import type { ProviderInfo } from './registry'

/** Per-provider concurrency (semaphore) and requests-per-minute limits. */
export class ProviderLimiter {
  private active = new Map<string, number>()
  private waiters = new Map<string, (() => void)[]>()
  private starts = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  inFlight(providerId: string): number {
    return this.active.get(providerId) ?? 0
  }

  hasCapacity(p: ProviderInfo): boolean {
    return this.inFlight(p.id) < p.concurrency && this.rpmWaitMs(p) === 0
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
  }
}
