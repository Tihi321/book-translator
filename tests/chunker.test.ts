import { describe, expect, it } from 'vitest'
import { chunkBudget, planChunks, segmentsForBlock, SEG_OVERHEAD } from '../src/engine/chunker'
import type { Block, DocumentIR } from '../src/shared/ir'
import { countTokens } from '../src/engine/tokens'

const block = (id: string, text: string, kind: Block['kind'] = 'para'): Block => ({ id, kind, text, tags: [] })
const ir = (...sections: Block[][]): DocumentIR => ({ format: 'md', meta: {}, sections: sections.map((blocks, i) => ({ id: `s${i + 1}`, blocks })) })
const words = (n: number, w = 'word') => Array.from({ length: n }, () => w).join(' ')

describe('chunkBudget', () => {
  it('caps at the user maximum for big contexts', () => {
    expect(chunkBudget({ contexts: [1_000_000] })).toBe(1500)
    expect(chunkBudget({ contexts: [8192], userMax: 800 })).toBe(800)
  })

  it('follows the formula for small contexts', () => {
    // (4096 - 600 - 400 - 400 - ceil(4096 * 0.15)) / 2.3
    const expected = Math.floor((4096 - 600 - 400 - 400 - Math.ceil(4096 * 0.15)) / 2.3)
    expect(chunkBudget({ contexts: [4096] })).toBe(expected)
    expect(expected).toBeLessThan(1500)
  })

  it('uses the smallest context of the agents', () => {
    expect(chunkBudget({ contexts: [200_000, 4096, 32_000] })).toBe(chunkBudget({ contexts: [4096] }))
  })

  it('defaults to 8192 without contexts and never goes below a minimum', () => {
    expect(chunkBudget({ contexts: [] })).toBe(chunkBudget({ contexts: [8192] }))
    expect(chunkBudget({ contexts: [1000] })).toBe(100)
  })
})

describe('planChunks', () => {
  it('packs whole blocks greedily within the budget', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => block(`b${i + 1}`, words(20)))
    const per = countTokens(words(20)) + SEG_OVERHEAD
    const chunks = planChunks(ir(blocks), per * 3 + 1)
    expect(chunks.map((c) => c.segments.length)).toEqual([3, 3, 3, 1])
    expect(chunks.map((c) => c.index)).toEqual([1, 2, 3, 4])
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(per * 3 + 1)
    expect(chunks.flatMap((c) => c.segments.map((s) => s.id))).toEqual(blocks.map((b) => b.id))
  })

  it('never crosses a section boundary', () => {
    const chunks = planChunks(ir([block('b1', 'One short.'), block('b2', 'Two short.')], [block('b3', 'Three.')]), 1500)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.sectionId).toBe('s1')
    expect(chunks[0]!.segments.map((s) => s.id)).toEqual(['b1', 'b2'])
    expect(chunks[1]!.sectionId).toBe('s2')
  })

  it('leaves out meta and empty blocks', () => {
    const chunks = planChunks(ir([block('b1', 'Text.'), block('b2', '```\ncode\n```', 'meta'), block('b3', '  '), block('b4', 'More.')]), 1500)
    expect(chunks[0]!.segments.map((s) => s.id)).toEqual(['b1', 'b4'])
  })

  it('splits an over-budget block at sentence boundaries', () => {
    const sentence = 'This is a reasonably short sentence about nothing in particular.'
    const text = Array.from({ length: 30 }, () => sentence).join(' ')
    const budget = 150
    const chunks = planChunks(ir([block('b1', 'Intro.'), block('b2', text), block('b3', 'Outro.')]), budget)
    const segs = chunks.flatMap((c) => c.segments)
    const parts = segs.filter((s) => s.blockId === 'b2')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map((p) => p.id)).toEqual(parts.map((_, i) => `b2#${i + 1}`))
    expect(parts.every((p) => p.parts === parts.length)).toBe(true)
    for (const p of parts) {
      expect(countTokens(p.text) + SEG_OVERHEAD).toBeLessThanOrEqual(budget)
      expect(p.text.endsWith('.')).toBe(true) // cut at sentence ends
    }
    expect(parts.map((p) => p.text).join(' ')).toBe(text)
    for (const c of chunks) expect(c.tokens).toBeLessThanOrEqual(budget)
  })

  it('cuts a single huge sentence at words', () => {
    const segs = segmentsForBlock({ id: 'b1', text: words(400) }, 120)
    expect(segs.length).toBeGreaterThan(2)
    for (const s of segs) expect(countTokens(s.text)).toBeLessThanOrEqual(120)
  })

  it('does not break inside an inline tag pair', () => {
    const text = `Before. <1>${Array.from({ length: 20 }, () => 'Inside the pair.').join(' ')}</1> After.`
    const segs = segmentsForBlock({ id: 'b1', text }, 60)
    for (const s of segs) {
      const open = (s.text.match(/<1>/g) ?? []).length
      const close = (s.text.match(/<\/1>/g) ?? []).length
      expect(open).toBe(close)
    }
  })
})
