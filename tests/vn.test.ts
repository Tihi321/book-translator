import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { adapterFor, formatOf, hashSource } from '../src/engine/formats'
import { classifyScriptLine, readVnFolder, writeVnFolder, yamlScalar } from '../src/engine/formats/vn'
import { parseGlossary } from '../src/engine/pipeline/glossary'
import type { ChatRequest } from '../src/engine/models/types'
import { splitFrontmatter } from '../src/shared/md'
import type { DocumentIR } from '../src/shared/ir'
import { tempDir } from './helpers'
import { asSegs, lastUser, MODEL, QA_MODEL, rig, segsIn } from './pipelineHelpers'
import type { Rig } from './pipelineHelpers'

const SOOTHER = path.resolve(__dirname, 'fixtures', 'books', 'soother')

const cleanups: (() => Promise<void>)[] = []
let r: Rig | undefined
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  await r?.cleanup()
  r = undefined
})

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.cp(src, dst, { recursive: true })
}

async function tmp(): Promise<string> {
  const { dir, cleanup } = await tempDir('bt-vn-')
  cleanups.push(cleanup)
  return dir
}

// The patterns of Scriptorium's renderer (docs/visual-novel.md): an exported chapter has to read the same with them.
const SCENE = /^\**\s*scene\s*:\s*\**\s*(.+?)\s*\**$/i
const CAST = /^\**\s*on screen\s*:\s*\**\s*(.+?)\s*\**$/i
const LINE = /^\**([\p{Lu}][\p{Lu}\p{N}'’ .-]{0,40}?)\**(?:\s*\(([^)]{1,120})\))?\s*:\**\s+(.+)$/u

/** What each line of a chapter body is, by Scriptorium's grammar: the shape must survive the translation. */
function shapes(body: string): string[] {
  return body.split(/\r?\n/).map((raw) => {
    const t = raw.trim()
    if (!t) return 'blank'
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) return 'break'
    if (SCENE.test(t)) return 'scene'
    const c = CAST.exec(t)
    if (c) return `cast ${c[1]}`
    const l = LINE.exec(t)
    if (l) return `line ${l[1]} (${l[2] ?? ''})`
    if (/^narration:/i.test(t)) return 'narration:'
    return 'narration'
  })
}

/** An LLM-like translation: keeps a leading speaker tag and puts a marker before the words. */
const translate = (text: string) => text.replace(/^(<1>[\s\S]*?<\/1>\s*)?([\s\S]*)$/, (_m, tag: string | undefined, rest: string) => `${tag ?? ''}[hr] ${rest}`)

function allBlocks(ir: DocumentIR) {
  return ir.sections.flatMap((s) => s.blocks)
}

async function exportWith(ir: DocumentIR, src: string, fn: (text: string, id: string) => string | undefined): Promise<{ out: string; warnings: string[] }> {
  const out = path.join(await tmp(), 'soother.hr')
  const tr = new Map<string, string>()
  for (const b of allBlocks(ir)) {
    const t = fn(b.text, b.id)
    if (t !== undefined) tr.set(b.id, t)
  }
  const warnings: string[] = []
  await writeVnFolder(tr, src, out, { onWarning: (m) => warnings.push(m) })
  return { out, warnings }
}

const chapterFiles = async (dir: string) => (await fs.readdir(path.join(dir, 'chapters'))).sort()

describe('visual-novel book folder adapter', () => {
  it('is picked for a Scriptorium book folder, and a plain folder is refused', async () => {
    expect(formatOf(SOOTHER)).toBe('vn')
    expect(adapterFor(SOOTHER).outputExt).toBe('')
    const empty = await tmp()
    expect(() => adapterFor(empty)).toThrow(/not a visual-novel book folder/)
    expect(await hashSource(SOOTHER)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads one section per file and one block per text span, leaving markers, frontmatter keys, bible and cover brief out', async () => {
    const ir = await adapterFor(SOOTHER).read(SOOTHER)
    expect(ir.format).toBe('vn')
    expect(ir.meta.title).toBe('The Soother That Fell Into Dragon Land')
    expect(ir.meta.names).toEqual(['Petra', 'Pip', 'Mango', 'Grumble', 'Nib'])
    expect(ir.sections.map((s) => s.title)).toEqual(['book.md', 'outline.md', 'The Grumpy Throw', 'The Lost Things Office', "The Singing Dragons' Chorus", 'The Golden Cave', 'The Bouncing Mud Puddles', 'The Red Boot Trade', 'The Button Trade'])

    const book = ir.sections[0]!.blocks.map((b) => b.text)
    expect(book).toEqual(['The Soother That Fell Into Dragon Land', expect.stringMatching(/^When Petra grumpily throws/)])

    const outline = ir.sections[1]!.blocks.map((b) => b.text)
    expect(outline).toContain('Follow Mango to the Lost Things Office')
    expect(outline).toContain("happy: the soother is returned, and Petra's kindness is rewarded")
    expect(outline).toContain('**The Grumpy Throw**: Petra is annoyed by baby Pip\'s crying and tosses his soother over the mountains. She feels sorry at once, and a friendly wind carries her over the mountains into Dragon Land. She lands near a bubble-gum volcano and meets Mango, a small orange dragon who collects lost things.')
    expect(outline.some((t) => /^\d+\.\s|^- |^kind:|^outline$/.test(t))).toBe(false)

    const ch1 = ir.sections[2]!.blocks
    expect(ch1[0]).toMatchObject({ kind: 'heading', text: 'The Grumpy Throw' })
    const texts = ch1.map((b) => b.text)
    expect(texts).toContain("Petra's garden, morning. A small cottage with a red door. Baby clothes flap on a clothesline. The sky is soft blue.")
    expect(texts).toContain('The sun is warm. Flowers nod in the breeze. It should be a nice day.')
    expect(texts).toContain('<1>PETRA (grumpy):</1> Pip, shhh! I am trying to build a sandcastle.')
    expect(ch1.find((b) => b.text.startsWith('<1>'))!.tags).toEqual([{ n: 1, kind: 'pair', data: 'speaker' }])
    for (const t of allBlocks(ir).map((b) => b.text)) {
      expect(t).not.toMatch(/SCENE:|ON SCREEN:|^Narration:|^---$|^kind:|Characters/)
      expect(t).not.toContain('\n')
    }
  })

  it('writes the folder back byte for byte without translations', async () => {
    const ir = await readVnFolder(SOOTHER)
    const { out, warnings } = await exportWith(ir, SOOTHER, () => undefined)
    expect(warnings).toEqual([])
    for (const rel of ['book.md', 'outline.md', 'bible/bible.md', 'cover-brief.md', ...(await chapterFiles(SOOTHER)).map((c) => `chapters/${c}`)]) {
      expect(await fs.readFile(path.join(out, rel), 'utf8'), rel).toBe(await fs.readFile(path.join(SOOTHER, rel), 'utf8'))
    }
  })

  it('translated chapters keep every line, marker, speaker tag and expression; frontmatter keeps its keys', async () => {
    const ir = await readVnFolder(SOOTHER)
    const { out, warnings } = await exportWith(ir, SOOTHER, (t) => translate(t))
    expect(warnings).toEqual([])
    for (const c of await chapterFiles(SOOTHER)) {
      const src = await fs.readFile(path.join(SOOTHER, 'chapters', c), 'utf8')
      const dst = await fs.readFile(path.join(out, 'chapters', c), 'utf8')
      expect(dst.split('\n').length, c).toBe(src.split('\n').length)
      const s = splitFrontmatter(src)
      const d = splitFrontmatter(dst)
      expect(shapes(d.body), c).toEqual(shapes(s.body))
      const sData = parseYaml(s.frontmatter!) as Record<string, unknown>
      const dData = parseYaml(d.frontmatter!) as Record<string, unknown>
      expect(dData).toEqual({ ...sData, title: `[hr] ${String(sData.title)}` })
      // every text line changed, every kept line is the same
      const sl = s.body.split('\n')
      d.body.split('\n').forEach((line, i) => {
        const shape = shapes(sl[i]!)[0]!
        if (shape === 'blank' || shape === 'break' || shape.startsWith('cast')) expect(line).toBe(sl[i])
        else expect(line, `${c}:${i}`).toContain('[hr] ')
      })
    }
    const ch1 = await fs.readFile(path.join(out, 'chapters', 'ch-01.md'), 'utf8')
    expect(ch1).toContain("SCENE: [hr] Petra's garden, morning.")
    expect(ch1).toContain('Narration: [hr] The sun is warm.')
    expect(ch1).toContain('PETRA (grumpy): [hr] Pip, shhh! I am trying to build a sandcastle.')
    expect(ch1).toContain('ON SCREEN: Pip (in a green onesie, red face, crying), Petra (yellow raincoat, hands over ears)')

    // outline: the chapter map still works (numbers, choices, endings), its texts are translated
    const o = parseYaml(splitFrontmatter(await fs.readFile(path.join(out, 'outline.md'), 'utf8')).frontmatter!) as { kind: string; chapters: { n: number; title: string; summary: string; choices?: { text: string; to: number }[]; ending?: string }[] }
    const so = parseYaml(splitFrontmatter(await fs.readFile(path.join(SOOTHER, 'outline.md'), 'utf8')).frontmatter!) as typeof o
    expect(o.kind).toBe('outline')
    expect(o.chapters.map((c) => c.n)).toEqual(so.chapters.map((c) => c.n))
    o.chapters.forEach((c, i) => {
      const sc = so.chapters[i]!
      expect(c.title).toBe(`[hr] ${sc.title}`)
      expect(c.summary).toBe(`[hr] ${sc.summary}`)
      expect(c.choices?.map((x) => x.to)).toEqual(sc.choices?.map((x) => x.to))
      expect(c.choices?.map((x) => x.text)).toEqual(sc.choices?.map((x) => `[hr] ${x.text}`))
      if (sc.ending) expect(c.ending).toBe(`[hr] ${sc.ending}`)
    })
    const outlineBody = splitFrontmatter(await fs.readFile(path.join(out, 'outline.md'), 'utf8')).body
    expect(outlineBody).toContain('1. [hr] **The Grumpy Throw**:')
    expect(outlineBody).toContain('   - [hr] Choices: "Follow Mango')

    const book = await fs.readFile(path.join(out, 'book.md'), 'utf8')
    const bookData = parseYaml(splitFrontmatter(book).frontmatter!) as Record<string, unknown>
    expect(bookData.title).toBe('[hr] The Soother That Fell Into Dragon Land')
    expect(bookData.slug).toBe('the-soother-that-fell-into-dragon-land')
    expect(bookData.script).toBe(true)
    expect(String(bookData.blurb)).toMatch(/^\[hr\] When Petra/)
    expect(splitFrontmatter(book).body).toBe(splitFrontmatter(await fs.readFile(path.join(SOOTHER, 'book.md'), 'utf8')).body)
    for (const rel of ['bible/bible.md', 'cover-brief.md']) expect(await fs.readFile(path.join(out, rel), 'utf8')).toBe(await fs.readFile(path.join(SOOTHER, rel), 'utf8'))
  })

  it('keeps a script safe from bad translations: lost tags, line breaks, a line that would change its kind, empty text', async () => {
    const dir = await tmp()
    const src = path.join(dir, 'book')
    await fs.mkdir(path.join(src, 'chapters'), { recursive: true })
    await fs.writeFile(path.join(src, 'book.md'), '---\ntitle: A Book\nscript: true\n---\n', 'utf8')
    const script = ['---', 'n: 1', 'title: "One: the start"', '---', '', 'SCENE: The harbour wall, dusk', 'Rain on the water.', 'ON SCREEN: Mara (worried)', 'MARA (worried): He said he would be back.', 'TOMAS: Hello.', '**MARA** (annoyed): You are *late*.', 'Footsteps.', 'FADE OUT.', '---', '## The kitchen, night', 'A low room.', ''].join('\r\n')
    await fs.writeFile(path.join(src, 'chapters', 'ch-01.md'), script, 'utf8')
    const ir = await readVnFolder(src)
    const texts = allBlocks(ir).map((b) => b.text)
    expect(texts).toEqual(['A Book', 'One: the start', 'The harbour wall, dusk', 'Rain on the water.', '<1>MARA (worried):</1> He said he would be back.', '<1>TOMAS:</1> Hello.', '<1>**MARA** (annoyed):</1> You are *late*.', 'Footsteps.', 'The kitchen, night', 'A low room.'])

    const answers: Record<string, string> = {
      'A Book': 'Knjiga: prva',
      'One: the start': '[Jedan], početak',
      'The harbour wall, dusk': 'Lučki zid,\nsumrak',
      'Rain on the water.': 'MARA: Kiša.', // would read as a spoken line: the source is kept
      '<1>MARA (worried):</1> He said he would be back.': 'MARA (zabrinuto): Rekao je da će se vratiti.', // the tags were lost
      '<1>TOMAS:</1> Hello.': '<1>TOMAS:</1> Bok.',
      '<1>**MARA** (annoyed):</1> You are *late*.': '<1>**MARA** (ljutito):</1> *Kasniš*.',
      'Footsteps.': '   ',
      'The kitchen, night': 'Kuhinja, noć',
      'A low room.': '# Niska soba' // would read as a heading
    }
    const { out, warnings } = await exportWith(ir, src, (t) => answers[t])
    const result = await fs.readFile(path.join(out, 'chapters', 'ch-01.md'), 'utf8')
    expect(result.split('\r\n')).toEqual([
      '---',
      'n: 1',
      'title: "[Jedan], početak"',
      '---',
      '',
      'SCENE: Lučki zid, sumrak',
      'Rain on the water.',
      'ON SCREEN: Mara (worried)',
      'MARA (worried): Rekao je da će se vratiti.',
      'TOMAS: Bok.',
      '**MARA** (annoyed): *Kasniš*.',
      'Footsteps.',
      'FADE OUT.',
      '---',
      '## Kuhinja, noć',
      'A low room.',
      ''
    ])
    expect(warnings).toHaveLength(3)
    expect(warnings.join('\n')).toMatch(/ch-01\.md.*MARA: Kiša/)
    expect(parseYaml(splitFrontmatter(await fs.readFile(path.join(out, 'book.md'), 'utf8')).frontmatter!)).toEqual({ title: 'Knjiga: prva', script: true })
  })

  it('classifies script lines like Scriptorium, with the Croatian keywords VN Studio reads', () => {
    expect(classifyScriptLine('SCENE: A, dusk')).toMatchObject({ cls: 'scene', prefix: 'SCENE: ', text: 'A, dusk' })
    expect(classifyScriptLine('**Scena:** Kuhinja, noć')).toMatchObject({ cls: 'scene', text: 'Kuhinja, noć' })
    expect(classifyScriptLine('NA EKRANU: Mara (umorna)').cls).toBe('cast')
    expect(classifyScriptLine('Naracija: Kiša pada.')).toMatchObject({ cls: 'narration', prefix: 'Naracija: ', text: 'Kiša pada.' })
    expect(classifyScriptLine('CUT TO: Grumble sets it down.')).toMatchObject({ cls: 'line', prefix: 'CUT TO: ' })
    expect(classifyScriptLine('FADE OUT.').cls).toBe('direction')
    expect(classifyScriptLine('***').cls).toBe('break')
    expect(classifyScriptLine('Narration:').cls).toBe('narration')
    expect(classifyScriptLine('Narration:').text).toBe('')
  })

  it('writes YAML values that read back as the translation', () => {
    for (const [text, style, flow] of [
      ['plain words', 'PLAIN', false],
      ['a: b', 'PLAIN', false],
      ['[hr] x', 'PLAIN', false],
      ['one, two', 'PLAIN', true],
      ["it's", 'QUOTE_SINGLE', false],
      ['true', 'PLAIN', false],
      ['- dash', 'BLOCK_FOLDED', false],
      ['say "hi" # not a comment', 'QUOTE_DOUBLE', false]
    ] as const) {
      const s = yamlScalar(text, style, flow)
      const doc = parseYaml(flow ? `{k: ${s}, to: 2}` : `k: ${s}`) as { k: unknown }
      expect(doc.k, `${text} -> ${s}`).toBe(text)
    }
    expect(yamlScalar('plain words', 'PLAIN', false)).toBe('plain words')
    expect(yamlScalar("it's", 'QUOTE_SINGLE', false)).toBe("'it''s'")
  })
})

describe('visual-novel book folder through the engine (mock models)', () => {
  it('creates one project for the folder, keeps the character names, runs the pipeline and exports a folder that still parses', async () => {
    r = await rig()
    const book = path.join(r.dir, 'books', 'soother')
    await copyDir(SOOTHER, book)
    let system = ''
    r.mock.on({ role: 'translator' }, (req: ChatRequest) => {
      system = req.messages[0]!.content
      return asSegs(segsIn(lastUser(req)).map((s) => ({ id: s.id, text: translate(s.text) })))
    })
    const p = await r.service.createProject({
      sourcePath: book,
      targetLanguage: 'Croatian',
      sourceLanguage: 'English',
      settings: { agentModels: { glossary: [MODEL], translator: [MODEL], proofreader: [MODEL], qa: [QA_MODEL] }, enabled: { glossary: true, proofreader: true, qa: true }, maxChunkTokens: 400 }
    })
    expect(p.format).toBe('vn')
    expect(p.name).toBe('The Soother That Fell Into Dragon Land')
    expect(p.id).toMatch(/^soother-hr-[0-9a-f]{6}$/)
    // the same folder and language give the same project
    expect((await r.service.createProject({ sourcePath: book, targetLanguage: 'Croatian' })).id).toBe(p.id)

    const res = await r.service.start(p.id)
    expect(res.status).toBe('done')
    expect(system).toContain('visual-novel script')
    expect(system).toContain('Genre: fiction') // the brief the glossary builder wrote is kept with the note
    const glossary = parseGlossary(await fs.readFile(r.service.store.file(p.id, 'glossary.md'), 'utf8'))
    for (const name of ['Petra', 'Pip', 'Mango', 'Grumble', 'Nib']) expect(glossary.find((e) => e.source === name)?.target).toBe(name)

    const out = await r.service.export(p.id)
    expect(path.basename(out)).toBe('soother.hr')
    for (const c of await chapterFiles(book)) {
      const src = splitFrontmatter(await fs.readFile(path.join(book, 'chapters', c), 'utf8'))
      const dst = splitFrontmatter(await fs.readFile(path.join(out, 'chapters', c), 'utf8'))
      expect(dst.body.split('\n').length, c).toBe(src.body.split('\n').length)
      expect(shapes(dst.body), c).toEqual(shapes(src.body))
    }
    const ch1 = await fs.readFile(path.join(out, 'chapters', 'ch-01.md'), 'utf8')
    // the scripted proofreader adds a check mark at the end of each segment
    expect(ch1).toContain('PETRA (grumpy): [hr] Pip, shhh! I am trying to build a sandcastle. ✓')
    expect(await fs.readFile(path.join(out, 'bible', 'bible.md'), 'utf8')).toBe(await fs.readFile(path.join(book, 'bible', 'bible.md'), 'utf8'))
  })
})
