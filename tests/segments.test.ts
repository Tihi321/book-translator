import { describe, expect, it } from 'vitest'
import { describeParse, formatSegments, parseSegments, salvage } from '../src/engine/pipeline/segments'

describe('segment protocol', () => {
  it('formats and parses a round trip', () => {
    const segs = [{ id: 'b1', text: 'One' }, { id: 'b2#1', text: 'Two\nlines' }]
    const p = parseSegments(formatSegments(segs), ['b1', 'b2#1'])
    expect(p.ok).toBe(true)
    expect(p.segments.get('b2#1')).toBe('Two\nlines')
  })

  it('reports missing, extra and duplicate ids', () => {
    const p = parseSegments('<seg id="a">A</seg><seg id="x">X</seg><seg id="c">C</seg><seg id="c">C2</seg>', ['a', 'b', 'c'])
    expect(p.ok).toBe(false)
    expect(p.missing).toEqual(['b'])
    expect(p.extra).toEqual(['x'])
    expect(p.duplicate).toEqual(['c'])
    expect(p.segments.get('c')).toBe('C')
    expect(describeParse(p)).toMatch(/missing.*b.*not asked for.*x.*repeated.*c/)
  })

  it('treats an empty segment as missing', () => {
    const p = parseSegments('<seg id="a">  </seg>', ['a'])
    expect(p.missing).toEqual(['a'])
  })

  it('tolerates fences, thinking, whitespace, quotes and chatter', () => {
    const reply = '<think>let me see <seg id="a">no</seg></think>\n```xml\n<seg   id = \'a\' >\n  Prvi  \n</seg>\n<seg id=b>Drugi</seg>\n```'
    const p = parseSegments(reply, ['a', 'b'])
    expect(p.ok).toBe(true)
    expect(p.segments.get('a')).toBe('Prvi')
    expect(p.segments.get('b')).toBe('Drugi')
    expect(parseSegments('Here you go:\n<seg id="a">A</seg>\nHope it helps', ['a']).ok).toBe(true)
  })

  it('keeps inline tags in the text', () => {
    const p = parseSegments('<seg id="a">Hello <1>big</1> world<2/></seg>', ['a'])
    expect(p.segments.get('a')).toBe('Hello <1>big</1> world<2/>')
  })

  it('finds nothing in free text', () => {
    const p = parseSegments('I cannot do that.', ['a'])
    expect(p.ok).toBe(false)
    expect(p.missing).toEqual(['a'])
  })

  it('salvage keeps good segments, asks for missing and garbled ones, and refuses drift', () => {
    const ids = ['a', 'b', 'c', 'd']
    const seg = (id: string, t: string) => `<seg id="${id}">${t}</seg>`
    // 1. an identical repeat (whitespace aside) is harmless
    const same = parseSegments([seg('a', 'A'), seg('b', 'B'), seg('b', ' B '), seg('c', 'C'), seg('d', 'D')].join(''), ids)
    expect(same.ok).toBe(false)
    expect(same.conflicting).toEqual([])
    expect(salvage(same, ids)).toMatchObject({ ask: [] })
    expect(parseSegments(seg('a', 'B  B') + seg('a', 'B B'), ['a']).conflicting).toEqual([])
    // 2. a conflicting repeat plus a missing id: both are asked, the conflicting one is not kept
    const garbled = parseSegments([seg('a', 'A'), seg('b', 'B'), seg('b', 'X'), seg('d', 'D')].join(''), ids)
    expect(garbled.conflicting).toEqual(['b'])
    const s = salvage(garbled, ids)!
    expect(s.ask).toEqual(['b', 'c'])
    expect([...s.keep.keys()]).toEqual(['a', 'd'])
    // 3. a stray id: the numbering drifted
    expect(salvage(parseSegments([seg('a', 'A'), seg('x', 'X')].join(''), ids), ids)).toBeUndefined()
    // 4. the limit is max(2, ceil(n / 4))
    const eight = 'abcdefgh'.split('')
    expect(salvage(parseSegments(['a', 'b', 'c', 'd', 'e'].map((i) => seg(i, i)).join(''), eight), eight)).toBeUndefined()
    expect(salvage(parseSegments(['a', 'b', 'c', 'd', 'e', 'f'].map((i) => seg(i, i)).join(''), eight), eight)?.ask).toEqual(['g', 'h'])
    // 5. two ids with one missing is fine, an empty reply for one id is not
    expect(salvage(parseSegments(seg('a', 'A'), ['a', 'b']), ['a', 'b'])?.ask).toEqual(['b'])
    expect(salvage(parseSegments('', ['a']), ['a'])).toBeUndefined()
  })
})
