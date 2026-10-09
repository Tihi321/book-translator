import { describe, expect, it } from 'vitest'
import { stripTags, tagTokens, validateTags } from '../src/engine/formats/inline'

describe('inline tags', () => {
  it('accepts a translation with the same tags, in any order across pairs', () => {
    expect(validateTags('Hello <1>big</1> world<2/>', 'Pozdrav <1>veliki</1> svijete<2/>').ok).toBe(true)
    expect(validateTags('<1>a</1> <2>b</2>', '<2>b</2> <1>a</1>').ok).toBe(true)
  })

  it('reports missing and extra tags', () => {
    const r = validateTags('A <1>b</1> c<2/>', 'A b c')
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(expect.arrayContaining(['<1>', '</1>', '<2/>']))
    const e = validateTags('plain', 'plain <3>x</3>')
    expect(e.ok).toBe(false)
    expect(e.extra).toEqual(['<3>', '</3>'])
  })

  it('rejects a duplicated tag and mis-nested pairs', () => {
    expect(validateTags('<1>a</1>', '<1>a</1><1>a</1>').ok).toBe(false)
    const r = validateTags('<1>a <2>b</2></1>', '<1>a <2>b</1></2>')
    expect(r.ok).toBe(false)
    expect(r.misnested).toBe(true)
  })

  it('ignores angle brackets that are not placeholders', () => {
    expect(tagTokens('if a < b and c > d, <html> 1<2')).toEqual([])
    expect(validateTags('x < y', 'x < y').ok).toBe(true)
  })

  it('strips tags to plain text', () => {
    expect(stripTags('Hello <1>big <2>bold</2></1> world<3/>!')).toBe('Hello big bold world!')
    expect(stripTags('no tags')).toBe('no tags')
  })
})
