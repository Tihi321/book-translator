import { z } from 'zod'
import { chunkBudget, planChunks } from '../chunker'
import { isAbortError } from '../models/types'
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

const wordRe = new Map<string, RegExp | null>()

/** A whole-word, case-insensitive matcher for a glossary source term: letters and digits on either side break the match, spaces in the term match any run of white space. */
function termRegExp(term: string): RegExp | null {
  const key = normalizeTerm(term)
  let re = wordRe.get(key)
  if (re === undefined) {
    const body = key
      .split(' ')
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+')
    re = body ? new RegExp('(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'iu') : null
    wordRe.set(key, re)
  }
  return re
}

/** The entries whose source term occurs in the text as a whole word or phrase (case-insensitive, Unicode-aware: "Da" is not found in "day"). */
export function relevantEntries(entries: readonly GlossaryEntry[], text: string, limit = 60): GlossaryEntry[] {
  const hay = text.normalize('NFC')
  const out: GlossaryEntry[] = []
  for (const e of entries) {
    const re = termRegExp(e.source)
    if (re && re.test(hay)) out.push(e)
    if (out.length >= limit) break
  }
  return out
}

/**
 * True when the translation has the glossary target, also in an inflected form: every word of the target counts as present when its stem
 * is (the word minus its last 2 letters when it has 7 or more, minus the last letter when it has 5 or 6, whole when shorter).
 */
export function hasTarget(translation: string, target: string): boolean {
  const hay = translation.normalize('NFC').toLowerCase()
  const words = target.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  return words.every((w) => {
    const letters = Array.from(w)
    const cut = letters.length >= 7 ? 2 : letters.length >= 5 ? 1 : 0
    return hay.includes(letters.slice(0, letters.length - cut).join(''))
  })
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

/**
 * Merges a generated brief into the user's brief text: the user's text stays as it is, and only what it lacks is added
 * (a field line whose label it does not have, characters whose name it does not mention). An empty brief text becomes the generated one.
 */
export function mergeBriefText(existing: string, generated: Brief): string {
  const have = existing.trim()
  if (!have) return serializeBrief(generated)
  const lower = have.toLowerCase()
  const fields: [string, string | undefined, string[]][] = [
    ['Genre', generated.genre, ['genre']],
    ['Tone', generated.tone, ['tone']],
    ['Register', generated.register, ['register']],
    ['Narrator and point of view', generated.pov, ['point of view', 'narrator', 'pov']],
    ['Address (formal or informal)', generated.address, ['address', 'formal']]
  ]
  const add: string[] = []
  for (const [label, value, keys] of fields) {
    if (value?.trim() && !keys.some((k) => lower.includes(k))) add.push(`- ${label}: ${value.trim()}`)
  }
  const chars = generated.characters.filter((c) => c.name.trim() && !lower.includes(c.name.trim().toLowerCase()))
  if (chars.length > 0) {
    if (!/^#+\s*characters/im.test(have)) add.push('', '## Characters', '')
    for (const c of chars) add.push(`- ${c.name}${c.gender ? ` (${c.gender})` : ''}${c.note ? `: ${c.note}` : ''}`)
  }
  return add.length === 0 ? have + '\n' : `${have}\n\n${add.join('\n').replace(/^\n+/, '')}\n`
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

/** Output cap for one glossary pass. Thinking models count their thinking against it, so it leaves room for that. */
const GLOSSARY_MAX_TOKENS = 16000

export interface GlossaryBuildResult {
  entries: GlossaryEntry[]
  brief: Brief
  passes: number
  /** Passes whose model call failed: they were skipped, the terms of the other passes are kept. */
  failed: number
}

/**
 * The glossary pre-pass: goes over the whole source in large chunks, asks for terms and (in the first pass) the book brief,
 * merges the terms across passes. Entries already in `existing` (for example edited by the user) win. A pass that fails is skipped
 * (the terms found so far are kept); only when every pass fails does the error reach the caller.
 * `localizeNames`: the character names of a visual novel, which the builder is asked to give a form for the target language (a `person` term each).
 */
export async function buildGlossary(
  env: AgentEnv,
  ir: DocumentIR,
  opts: { contexts: number[]; existing?: GlossaryEntry[]; unit?: string; localizeNames?: string[] }
): Promise<GlossaryBuildResult> {
  const budget = chunkBudget({ contexts: opts.contexts, userMax: 6000, promptOverhead: 900, glossarySlice: 1500, prevContext: 0, expansion: 0.4 })
  // sections do not matter here: the passes read the book as one text
  const flat: DocumentIR = { ...ir, sections: [{ id: 'all', blocks: ir.sections.flatMap((s) => s.blocks) }] }
  const passes = planChunks(flat, budget)
  let entries: GlossaryEntry[] = [...(opts.existing ?? [])]
  let brief: Brief = { characters: [] }
  const nameInstruction = opts.localizeNames?.length
    ? ` The character names of this visual novel are localized for ${env.targetLanguage} readers: add a term of type person for each of these names with the form ${env.targetLanguage} readers should see, the same form everywhere (it also becomes the speaker tag, so no colon or bracket in it); keep a name only when it already suits ${env.targetLanguage}: ${opts.localizeNames.slice(0, 80).join(', ')}.`
    : ''
  let first = true
  let failed = 0
  let lastError: unknown
  env.log('info', `glossary: reading the book in ${passes.length} pass(es)`)
  for (const pass of passes) {
    if (env.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    env.log('info', `glossary pass ${pass.index} of ${passes.length} started`)
    const text = pass.segments.map((s) => s.text).join('\n\n')
    const messages = await buildMessages(
      env.dataDir,
      'glossary',
      {
        sourceLanguage: env.sourceLanguage,
        targetLanguage: env.targetLanguage,
        knownTerms: formatEntries(entries.slice(-150)) || '(none yet)',
        briefInstruction:
          (first
            ? 'Also fill "brief": the genre, tone, register, narrator and point of view, formal or informal address, and the main characters with their gender.'
            : 'Leave "brief" out, except for characters that are new in this text.') + nameInstruction
      },
      text
    )
    let value: z.output<typeof glossaryReplySchema>
    try {
      ;({ value } = await chatJson(chatFn(env, 'glossary', 'glossary', opts.unit ?? `glossary-${pass.index}`), messages, glossaryReplySchema, {
        temperature: 0.2,
        // a JSON list of terms is a few thousand tokens at most: the cap stops a model that loops on its answer
        maxTokens: GLOSSARY_MAX_TOKENS,
        signal: env.signal
      }))
    } catch (err) {
      if (env.signal?.aborted || isAbortError(err)) throw err
      // one bad pass (a thinking model that used up its answer budget, a server that went away) must not lose the terms of the others
      failed++
      lastError = err
      env.log('warn', `glossary pass ${pass.index} of ${passes.length} failed, skipped: ${(err as Error).message}`)
      continue
    }
    const found: GlossaryEntry[] = value.terms
      .filter((t) => t.source.trim() && t.target.trim())
      .map((t) => {
        const type = (t.type ?? 'term').toLowerCase().trim()
        const e: GlossaryEntry = { source: t.source.trim(), target: t.target.trim(), type: TYPES.has(type) ? type : 'term' }
        if (t.gender?.trim()) e.gender = t.gender.trim().toLowerCase()
        if (t.note?.trim()) e.note = t.note.trim()
        return e
      })
    const before = entries.length
    entries = mergeGlossary(entries, found)
    env.log('info', `glossary pass ${pass.index} of ${passes.length} done: ${entries.length - before} new term(s), ${entries.length} in all`)
    if (value.brief) {
      const b = value.brief
      if (first) brief = { genre: b.genre, tone: b.tone, register: b.register, pov: b.pov, address: b.address, characters: [] }
      for (const c of b.characters) {
        if (c.name.trim() && !brief.characters.some((x) => normalizeTerm(x.name) === normalizeTerm(c.name))) brief.characters.push({ name: c.name.trim(), gender: c.gender?.trim(), note: c.note?.trim() })
      }
      first = false
    }
  }
  if (passes.length > 0 && failed === passes.length) throw lastError instanceof Error ? lastError : new Error('every glossary pass failed')
  return { entries, brief, passes: passes.length, failed }
}
