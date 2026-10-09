import { describe, expect, it } from 'vitest'
import { mergeGlossary, parseGlossary, relevantEntries, serializeBrief, serializeGlossary } from '../src/engine/pipeline/glossary'
import type { GlossaryEntry } from '../src/shared/project'

const entries: GlossaryEntry[] = [
  { source: 'Alice', target: 'Alisa', type: 'person', gender: 'f', note: 'main character' },
  { source: 'A|B', target: 'A ili B', type: 'term' },
  { source: 'Wonderland', target: 'Zemlja čudesa', type: 'place', note: 'title: keep "|" safe' }
]

describe('glossary.md', () => {
  it('round trips through serialize and parse', () => {
    const md = serializeGlossary(entries)
    expect(md).toContain('| Source | Target | Type | Gender | Note |')
    expect(parseGlossary(md)).toEqual(entries)
  })

  it('parses a hand-edited table: extra text, no outer pipes, aligned separator, bad rows', () => {
    const md = `# My glossary

Some notes here.

Source | Target | Type | Gender | Note
:--- | :---: | --- | --- | ---
Bob | Bob | person | m |
| | empty source | term | | |
| Orphan | | term | | |
|Tree|Drvo|term||the old one|
`
    expect(parseGlossary(md)).toEqual([
      { source: 'Bob', target: 'Bob', type: 'person', gender: 'm' },
      { source: 'Tree', target: 'Drvo', type: 'term', note: 'the old one' }
    ])
  })

  it('merges by normalized source, existing entries win', () => {
    const merged = mergeGlossary([{ source: 'Alice', target: 'Alisa', type: 'person' }], [
      { source: ' alice ', target: 'Alica', type: 'person', gender: 'f', note: 'n' },
      { source: 'Bob', target: 'Bob', type: 'person' }
    ])
    expect(merged).toEqual([
      { source: 'Alice', target: 'Alisa', type: 'person', gender: 'f', note: 'n' },
      { source: 'Bob', target: 'Bob', type: 'person' }
    ])
  })

  it('selects entries whose source occurs in the text, case-insensitively', () => {
    expect(relevantEntries(entries, 'Then ALICE went to wonderland.').map((e) => e.source)).toEqual(['Alice', 'Wonderland'])
    expect(relevantEntries(entries, 'nothing here')).toEqual([])
  })

  it('serializes the brief as readable markdown', () => {
    const md = serializeBrief({ genre: 'fiction', tone: 'light', characters: [{ name: 'Alice', gender: 'f', note: 'protagonist' }] })
    expect(md).toContain('- Genre: fiction')
    expect(md).toContain('- Alice (f): protagonist')
  })
})
