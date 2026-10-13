import { describe, expect, it } from 'vitest'
import { ProviderLimiter, utcDay } from '../src/engine/models/limiter'
import type { ProviderInfo } from '../src/engine/models/registry'

const provider = (over: Partial<ProviderInfo> = {}): ProviderInfo =>
  ({ id: 'p', kind: 'openai-compat', enabled: true, local: false, concurrency: 2, concurrencyAuto: false, down: false, discover: false, discoverSkip: [], jsonSchema: true, loadModels: false, available: true, ...over }) as ProviderInfo

describe('ProviderLimiter per-day limits', () => {
  it('counts requests since midnight UTC and reports the day full at rpd', () => {
    let now = Date.UTC(2026, 9, 13, 10, 0, 0)
    const limiter = new ProviderLimiter(() => now)
    const p = provider({ rpd: 3 })
    expect(limiter.requestsToday('p')).toBe(0)
    for (let i = 0; i < 2; i++) limiter.noteRequest(p)
    expect(limiter.requestsToday('p')).toBe(2)
    expect(limiter.dayFull(p)).toBe(false)
    expect(limiter.hasCapacity(p)).toBe(true)
    limiter.noteRequest(p)
    expect(limiter.dayFull(p)).toBe(true)
    expect(limiter.hasCapacity(p)).toBe(false)
    now = Date.UTC(2026, 9, 13, 23, 59, 59)
    expect(limiter.dayFull(p)).toBe(true)
  })

  it('starts again after midnight UTC', () => {
    let now = Date.UTC(2026, 9, 13, 23, 59, 0)
    const limiter = new ProviderLimiter(() => now)
    const p = provider({ rpd: 1 })
    limiter.noteRequest(p)
    expect(limiter.dayFull(p)).toBe(true)
    now = Date.UTC(2026, 9, 14, 0, 0, 1)
    expect(limiter.requestsToday('p')).toBe(0)
    expect(limiter.dayFull(p)).toBe(false)
    expect(limiter.hasCapacity(p)).toBe(true)
  })

  it('markDayFull skips the provider until midnight UTC, and is news only the first time', () => {
    let now = Date.UTC(2026, 9, 13, 12, 0, 0)
    const limiter = new ProviderLimiter(() => now)
    const p = provider()
    expect(limiter.dayFull(p)).toBe(false)
    expect(limiter.markDayFull(p)).toBe(true)
    expect(limiter.markDayFull(p)).toBe(false)
    expect(limiter.dayFull(p)).toBe(true)
    expect(limiter.hasCapacity(p)).toBe(false)
    now = Date.UTC(2026, 9, 14, 0, 0, 0)
    expect(limiter.dayFull(p)).toBe(false)
  })

  it('without rpd the count alone never fills the day', () => {
    const limiter = new ProviderLimiter(() => Date.UTC(2026, 9, 13))
    const p = provider()
    for (let i = 0; i < 100; i++) limiter.noteRequest(p)
    expect(limiter.dayFull(p)).toBe(false)
  })

  it('keeps the days of providers apart', () => {
    const limiter = new ProviderLimiter(() => Date.UTC(2026, 9, 13))
    const a = provider({ id: 'a', rpd: 1 })
    const b = provider({ id: 'b', rpd: 1 })
    limiter.noteRequest(a)
    expect(limiter.dayFull(a)).toBe(true)
    expect(limiter.dayFull(b)).toBe(false)
  })

  it('dayResetsAt is the next midnight UTC, and utcDay names the day', () => {
    const now = Date.UTC(2026, 9, 13, 18, 30, 0)
    const limiter = new ProviderLimiter(() => now)
    expect(limiter.dayResetsAt()).toBe(Date.UTC(2026, 9, 14))
    expect(utcDay(now)).toBe('2026-10-13')
    expect(utcDay(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31')
  })
})

describe('ProviderLimiter slots', () => {
  it('wakeAll frees waiting requests when the concurrency went up', async () => {
    const limiter = new ProviderLimiter()
    const p = provider({ concurrency: 1 })
    await limiter.acquire(p)
    const order: string[] = []
    const w1 = limiter.acquire(p).then(() => order.push('w1'))
    const w2 = limiter.acquire(p).then(() => order.push('w2'))
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual([])
    p.concurrency = 3
    limiter.wakeAll(p)
    await Promise.all([w1, w2])
    expect(order.sort()).toEqual(['w1', 'w2'])
    expect(limiter.inFlight('p')).toBe(3)
  })

  it('wakeAll lets those that still do not fit wait again', async () => {
    const limiter = new ProviderLimiter()
    const p = provider({ concurrency: 1 })
    await limiter.acquire(p)
    let got = false
    void limiter.acquire(p).then(() => (got = true))
    limiter.wakeAll(p)
    await new Promise((r) => setTimeout(r, 5))
    expect(got).toBe(false)
    limiter.release(p)
    await new Promise((r) => setTimeout(r, 5))
    expect(got).toBe(true)
  })
})
