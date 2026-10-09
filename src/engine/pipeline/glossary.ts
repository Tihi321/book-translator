import { z } from 'zod'
import { chunkBudget, planChunks } from '../chunker'
import type { DocumentIR } from '../../shared/ir'
import type { GlossaryEntry } from '../../shared/project'
import { chatFn } from './env'
import type { AgentEnv } from './env'
import { chatJson } from './llm'
import { buildMessages } from './prompts'

// ---- glossary.md: a markdown table the user can edit ----

const HEADER = ['Source', 'Target', 'Type', 'Gender', 'Note']

const cell = (s: string | undefined) => (s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()

export function serializeGlossary(entries: readonly GlossaryEntry[]): string {
  const lines = [
    '# Glossary',
    '',
    'One row per term. Edit freely: the translator uses the rows whose source term occurs in the text it is translating. A pipe character inside a cell needs a backslash before it.',
    'Type: person, place, org, term or phrase. Gender: m, f or n, when it matters.',
    '',
    `| ${HEADER.join(' | ')} |`,
    `|${HEADER.map(() => '---').join('|')}|`
  ]
  for (const e of entries) lines.push(`| ${cell(e.source)} | ${cell(e.target)} | ${cell(e.type)} | ${cell(e.gender)} | ${cell(e.note)} |`)
  return lines.join('\n') + '\n'
}

function splitRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!
    if (c === '\\' && t[i + 1] === '|') {
      cur += '|'
      i++
    } else if (c === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += c
  }
  cells.push(cur.trim())
  return cells
}

/** Reads the table back. Text around the table is ignored; rows without a source or a target are skipped. */
export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('|')) continue
    const c = splitRow(line)
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue
    if (c[0]!.toLowerCase() === 'source' && (c[1] ?? '').toLowerCase() === 'target') continue
    const [source, target, type, gender, note] = c
    if (!source || !target) continue
    const e: GlossaryEntry = { source, target, type: type || 'term' }
    if (gender) e.gender = gender
    if (note) e.note = note
    entries.push(e)
  }
  return entries
}

export const normalizeTerm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

/** Adds the terms of `extra` that `base` does not have yet (by normalized source). Existing entries win, but gain a missing gender or note. */
export function mergeGlossary(base: readonly GlossaryEntry[], extra: readonly GlossaryEntry[]): GlossaryEntry[] {
  const out = base.map((e) => ({ ...e }))
  const index = new Map(out.map((e) => [normalizeTerm(e.source), e]))
  for (const e of extra) {
    const key = normalizeTerm(e.source)
    if (!key) continue
    const have = index.get(key)
    if (have) {
      if (!have.gender && e.gender) have.gender = e.gender
      if (!have.note && e.note) have.note = e.note
    } else {
      const copy = { ...e }
      out.push(copy)
      index.set(key, copy)
    }
  }
  return out
}

/** The entries whose source term occurs in the text (case-insensitive). */
export function relevantEntries(entries: readonly GlossaryEntry[], text: string, limit = 60): GlossaryEntry[] {
  const hay = text.normalize('NFC').toLowerCase()
  const out: GlossaryEntry[] = []
  for (const e of entries) {
    const s = e.source.normalize('NFC').toLowerCase().trim()
    if (s && hay.includes(s)) out.push(e)
    if (out.length >= limit) break
  }
  return out
}

export function formatEntries(entries: readonly GlossaryEntry[]): string {
  return entries
    .map((e) => {
      const meta = [e.type, e.gender ? `gender ${e.gender}` : ''].filter(Boolean).join(', ')
      return `- ${e.source} => ${e.target}${meta ? ` (${meta})` : ''}${e.note ? `: ${e.note}` : ''}`
    })
    .join('\n')
}

// ---- the book brief ----

export interface Brief {
  genre?: string
  tone?: string
  register?: string
  pov?: string
  address?: string
  characters: { name: string; gender?: string; note?: string }[]
}

export function serializeBrief(b: Brief): string {
  const lines = ['# Book brief', '']
  const add = (label: string, v?: string) => {
    if (v?.trim()) lines.push(`- ${label}: ${v.trim()}`)
  }
  add('Genre', b.genre)
  add('Tone', b.tone)
  add('Register', b.register)
  add('Narrator and point of view', b.pov)
  add('Address (formal or informal)', b.address)
  if (b.characters.length > 0) {
    lines.push('', '## Characters', '')
    for (const c of b.characters) lines.push(`- ${c.name}${c.gender ? ` (${c.gender})` : ''}${c.note ? `: ${c.note}` : ''}`)
  }
  return lines.join('\n') + '\n'
}

// ---- the glossary builder agent ----

const str = z.string().optional()
export const glossaryReplySchema = z.object({
  terms: z.array(z.object({ source: z.string(), target: z.string(), type: str, gender: str, note: str })).default([]),
  brief: z
    .object({
      genre: str,
      tone: str,
      register: str,
      pov: str,
      address: str,
      characters: z.array(z.object({ name: z.string(), gender: str, note: str })).default([])
    })
    .optional()
})

const TYPES = new Set(['person', 'place', 'org', 'term', 'phrase'])

export interface GlossaryBuildResult {
  entries: GlossaryEntry[]
  brief: Brief
  passes: number
}

/**
 * The glossary pre-pass: goes over the whole source in large chunks, asks for terms and (in the first pass) the book brief,
 * merges the terms across passes. Entries already in `existing` (for example edited by the user) win.
 */
export async function buildGlossary(
  env: AgentEnv,
  ir: DocumentIR,
  opts: { contexts: number[]; existing?: GlossaryEntry[]; unit?: string }
): Promise<GlossaryBuildResult> {
  const budget = chunkBudget({ contexts: opts.contexts, userMax: 6000, promptOverhead: 900, glossarySlice: 1500, prevContext: 0, expansion: 0.4 })
  // sections do not matter here: the passes read the book as one text
  const flat: DocumentIR = { ...ir, sections: [{ id: 'all', blocks: ir.sections.flatMap((s) => s.blocks) }] }
  const passes = planChunks(flat, budget)
  let entries: GlossaryEntry[] = [...(opts.existing ?? [])]
  let brief: Brief = { characters: [] }
  let first = true
  for (const pass of passes) {
    if (env.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const text = pass.segments.map((s) => s.text).join('\n\n')
    const messages = await buildMessages(
      env.dataDir,
      'glossary',
      {
        sourceLanguage: env.sourceLanguage,
        targetLanguage: env.targetLanguage,
        knownTerms: formatEntries(entries.slice(-150)) || '(none yet)',
        briefInstruction: first
          ? 'Also fill "brief": the genre, tone, register, narrator and point of view, formal or informal address, and the main characters with their gender.'
          : 'Leave "brief" out, except for characters that are new in this text.'
      },
      text
    )
    const { value } = await chatJson(chatFn(env, 'glossary', 'glossary', opts.unit ?? `glossary-${pass.index}`), messages, glossaryReplySchema, { temperature: 0.2, signal: env.signal })
    const found: GlossaryEntry[] = value.terms
      .filter((t) => t.source.trim() && t.target.trim())
      .map((t) => {
        const type = (t.type ?? 'term').toLowerCase().trim()
        const e: GlossaryEntry = { source: t.source.trim(), target: t.target.trim(), type: TYPES.has(type) ? type : 'term' }
        if (t.gender?.trim()) e.gender = t.gender.trim().toLowerCase()
        if (t.note?.trim()) e.note = t.note.trim()
        return e
      })
    entries = mergeGlossary(entries, found)
    if (value.brief) {
      const b = value.brief
      if (first) brief = { genre: b.genre, tone: b.tone, register: b.register, pov: b.pov, address: b.address, characters: [] }
      for (const c of b.characters) {
        if (c.name.trim() && !brief.characters.some((x) => normalizeTerm(x.name) === normalizeTerm(c.name))) brief.characters.push({ name: c.name.trim(), gender: c.gender?.trim(), note: c.note?.trim() })
      }
      first = false
    }
  }
  return { entries, brief, passes: passes.length }
}
