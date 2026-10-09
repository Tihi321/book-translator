import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { adapterFor, formatOf } from '../src/engine/formats'
import { parseText } from '../src/engine/formats/text'
import { tempDir } from './helpers'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const FENCE = '```'
const MD = [
  '# The Book',
  '',
  'Intro paragraph that',
  'wraps over two lines.',
  '',
  '## Chapter One',
  '',
  'First paragraph with *emphasis*.',
  '',
  '- item one',
  '- item two',
  '',
  FENCE + 'js',
  'const a = 1',
  '',
  'const b = 2',
  FENCE,
  '',
  'Last paragraph.',
  '',
  '',
  '## Chapter Two',
  'Text right after a heading.',
  ''
].join('\n')

const TXT = 'Preface text.\n\nChapter 1\n\nIt was a dark night.\n\nSecond paragraph.\n\nChapter 2\n\nAnother day.\n'

async function roundTrip(name: string, content: string, translate?: (text: string) => string) {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const src = path.join(dir, name)
  const out = path.join(dir, 'out-' + name)
  await fs.writeFile(src, content, 'utf8')
  const adapter = adapterFor(src)
  const ir = await adapter.read(src)
  const tr = new Map<string, string>()
  if (translate) for (const s of ir.sections) for (const b of s.blocks) tr.set(b.id, translate(b.text))
  await adapter.write(ir, tr, src, out)
  return { ir, result: await fs.readFile(out, 'utf8') }
}

describe('text adapter', () => {
  it('registry picks formats by extension', () => {
    expect(formatOf('a.md')).toBe('md')
    expect(formatOf('a.TXT')).toBe('txt')
    expect(formatOf('a.xyz')).toBeUndefined()
    expect(() => adapterFor('a.xyz')).toThrow(/unsupported/)
  })

  it('markdown: sections split at H1/H2, headings and kinds detected', () => {
    const ir = parseText(MD, 'md')
    expect(ir.meta.title).toBe('The Book')
    expect(ir.sections.map((s) => s.title)).toEqual(['The Book', 'Chapter One', 'Chapter Two'])
    const kinds = ir.sections.flatMap((s) => s.blocks.map((b) => b.kind))
    expect(kinds).toEqual(['heading', 'para', 'heading', 'para', 'item', 'meta', 'para', 'heading', 'para'])
    const code = ir.sections[1]!.blocks.find((b) => b.kind === 'meta')!
    expect(code.text).toContain('const b = 2')
    expect(ir.sections[0]!.blocks[1]!.text).toBe('Intro paragraph that\nwraps over two lines.')
  })

  it('txt: one section per chapter heading line', () => {
    const ir = parseText(TXT, 'txt')
    expect(ir.sections.map((s) => s.title)).toEqual([undefined, 'Chapter 1', 'Chapter 2'])
    expect(ir.sections[1]!.blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'para'])
  })

  it('txt without chapters is a single section', () => {
    const ir = parseText('One.\n\nTwo.\n', 'txt')
    expect(ir.sections).toHaveLength(1)
    expect(ir.sections[0]!.blocks).toHaveLength(2)
  })

  it('identity translation reproduces the markdown file', async () => {
    const { result } = await roundTrip('book.md', MD, (t) => t)
    expect(result).toBe(MD)
  })

  it('no translations at all reproduces the file (untranslated blocks keep source)', async () => {
    expect((await roundTrip('book.txt', TXT)).result).toBe(TXT)
  })

  it('identity reproduces CRLF files and a BOM', async () => {
    const crlf = '﻿' + TXT.replace(/\n/g, '\r\n')
    expect((await roundTrip('crlf.txt', crlf, (t) => t)).result).toBe(crlf)
  })

  it('writes translations and keeps untranslated blocks', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const src = path.join(dir, 'a.md')
    const out = path.join(dir, 'b.md')
    await fs.writeFile(src, '# Title\n\nHello.\n\nWorld.\n', 'utf8')
    const adapter = adapterFor(src)
    const ir = await adapter.read(src)
    await adapter.write(
      ir,
      new Map([
        ['b1', '# Naslov'],
        ['b2', 'Bok.']
      ]),
      src,
      out
    )
    expect(await fs.readFile(out, 'utf8')).toBe('# Naslov\n\nBok.\n\nWorld.\n')
  })

  it('handles an empty file', async () => {
    const { ir, result } = await roundTrip('empty.txt', '', (t) => t)
    expect(ir.sections).toHaveLength(0)
    expect(result).toBe('')
  })
})
