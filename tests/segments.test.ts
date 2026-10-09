import { describe, expect, it } from 'vitest'
import { describeParse, formatSegments, parseSegments } from '../src/engine/pipeline/segments'

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
})
