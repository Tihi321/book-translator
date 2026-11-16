import type { ChunkRecord, DialogueStyle, ProjectSettings, Typography, TypographyCheck } from '../../shared/project'

/**
 * Typography: how dialogue and quotations are marked in the translation. A brief that says nothing lets parallel translators drift
 * (one writes „…” dialogue, another en-dash dialogue), so the project carries a rule, and a deterministic check finds the drift.
 */

/** The literary default per target language, by primary language code. Only languages where one convention is clearly the usual one; others have no default. */
export const TYPOGRAPHY_DEFAULTS: Readonly<Record<string, Typography>> = {
  hr: { dialogue: 'dash', quotes: '„…”' },
  sr: { dialogue: 'dash', quotes: '„…”' },
  bs: { dialogue: 'dash', quotes: '„…”' },
  pl: { dialogue: 'dash', quotes: '„…”' },
  ru: { dialogue: 'dash', quotes: '«…»' },
  es: { dialogue: 'dash', quotes: '«…»' },
  en: { dialogue: 'quotes', quotes: '“…”' },
  de: { dialogue: 'quotes', quotes: '„…“' },
  cs: { dialogue: 'quotes', quotes: '„…“' }
}

const NAMES: Record<string, string> = { croatian: 'hr', serbian: 'sr', bosnian: 'bs', polish: 'pl', russian: 'ru', spanish: 'es', english: 'en', german: 'de', czech: 'cs' }

type LangSettings = Pick<ProjectSettings, 'targetLanguage' | 'targetLanguageCode' | 'typography'>

/** The primary language code of a target language given as a code (`hr`, `pt-BR`) or a name (`Croatian`), if the table knows it. */
export function languageCodeOf(s: Pick<ProjectSettings, 'targetLanguage' | 'targetLanguageCode'>): string | undefined {
  for (const v of [s.targetLanguageCode, s.targetLanguage]) {
    const k = v?.trim().toLowerCase()
    if (!k) continue
    if (NAMES[k]) return NAMES[k]
    const code = k.split(/[-_]/)[0]!
    if (TYPOGRAPHY_DEFAULTS[code]) return code
  }
  return undefined
}

/** The target language's default typography, if the table has one. */
export function languageDefault(s: Pick<ProjectSettings, 'targetLanguage' | 'targetLanguageCode'>): Typography | undefined {
  const code = languageCodeOf(s)
  return code ? TYPOGRAPHY_DEFAULTS[code] : undefined
}

/** What the project's typography is: its own setting, with the language's default for what it leaves out. Undefined when neither says how dialogue is marked. */
export function effectiveTypography(s: LangSettings): Typography | undefined {
  const code = languageCodeOf(s)
  const def = code ? TYPOGRAPHY_DEFAULTS[code] : undefined
  const own = s.typography
  if (!own?.dialogue && !own?.quotes && !own?.notes) return def
  const dialogue = own.dialogue ?? def?.dialogue
  // the default's quote marks only go with the default's dialogue style
  const quotes = own.quotes ?? (def && (!own.dialogue || own.dialogue === def.dialogue) ? def.quotes : undefined)
  return { ...(dialogue ? { dialogue } : {}), ...(quotes ? { quotes } : {}), ...(own.notes ? { notes: own.notes } : {}) }
}

/** The rule every translator and proofreader prompt carries, or undefined when there is nothing to say. */
export function typographyRule(t: Typography | undefined): string | undefined {
  if (!t) return undefined
  const parts: string[] = []
  if (t.dialogue === 'dash') parts.push(`Mark dialogue with a dash that starts the paragraph (an en dash: "– Text – he said."), never with quotation marks.${t.quotes ? ` Use ${t.quotes} only for quotations and titles inside narration.` : ''}`)
  else if (t.dialogue === 'quotes') parts.push(`Mark dialogue with quotation marks${t.quotes ? ` ${t.quotes}` : ''}, never with a dash at the start of the paragraph.`)
  else if (t.dialogue === 'guillemets') parts.push(`Mark dialogue with guillemets${t.quotes ? ` ${t.quotes}` : ' « »'}, never with a dash at the start of the paragraph.`)
  else if (t.quotes) parts.push(`Quotation marks: ${t.quotes}.`)
  if (t.notes?.trim()) parts.push(t.notes.trim())
  return parts.length > 0 ? `Typography (the same in every chunk of the book, whoever translates it): ${parts.join(' ')}` : undefined
}

/** The rule for a project's settings (its own typography, or the language's default). */
export const typographyRuleOf = (s: LangSettings): string | undefined => typographyRule(effectiveTypography(s))

// ---- the check ----

const DASH = /^[–—―]/
const QUOTE_OPEN = /^[„“"”]/
const GUILLEMET_OPEN = /^[«»]/

/** The text of a paragraph without leading inline tags (`<1>`), Markdown emphasis and spaces. */
const lead = (text: string): string => text.replace(/^(?:\s|<\/?\d+\/?>|[*_#>])+/, '')

/**
 * The dialogue style of a set of paragraphs: by the paragraphs that start with a dash or an opening quotation mark.
 * Undefined when fewer than 2 paragraphs do, 'mixed' when the commonest style does not have at least twice the next one's count.
 */
export function dialogueStyleOf(paragraphs: readonly string[]): DialogueStyle | 'mixed' | undefined {
  let dash = 0
  let quotes = 0
  let guil = 0
  for (const p of paragraphs) {
    const l = lead(p)
    if (DASH.test(l)) dash++
    else if (QUOTE_OPEN.test(l)) quotes++
    else if (GUILLEMET_OPEN.test(l)) guil++
  }
  if (dash + quotes + guil < 2) return undefined
  const ranked = ([['dash', dash], ['quotes', quotes], ['guillemets', guil]] as [DialogueStyle, number][]).sort((a, b) => b[1] - a[1])
  return ranked[0]![1] >= 2 * ranked[1]![1] ? ranked[0]![0] : 'mixed'
}

/** Each translated chunk's dialogue style, and whether the project mixes them or leaves the brief's. Reads only the chunk files: no model, no cost. */
export function typographyCheck(chunks: readonly ChunkRecord[], settings: LangSettings): TypographyCheck {
  const expected = effectiveTypography(settings)?.dialogue
  const styles: TypographyCheck['styles'] = {}
  for (const c of chunks) {
    if (c.state !== 'done' && c.state !== 'flagged') continue
    const texts = c.segments.map((s) => c.final[s.id]).filter((t): t is string => typeof t === 'string').flatMap((t) => t.split(/\n+/))
    const style = dialogueStyleOf(texts)
    if (style) (styles[style] ??= []).push(c.index)
  }
  const found = Object.entries(styles) as [DialogueStyle | 'mixed', number[]][]
  const commonest = [...found].sort((a, b) => b[1].length - a[1].length)[0]?.[0]
  const reference = expected ?? commonest
  const offending = found.filter(([s]) => s !== reference).flatMap(([, idx]) => idx).sort((a, b) => a - b)
  const inconsistent = offending.length > 0
  const list = (idx: number[]) => (idx.length > 6 ? `${idx.slice(0, 6).join(', ')} and ${idx.length - 6} more` : idx.join(', '))
  let message = 'dialogue style consistent'
  if (found.length === 0) message = 'no dialogue style to check yet'
  else if (inconsistent) {
    const per = found.map(([s, idx]) => `${s} in chunk${idx.length > 1 ? 's' : ''} ${list(idx)}`).join('; ')
    message = expected ? `dialogue style differs from the brief (${expected}): ${per}` : `chunks mix dialogue styles: ${per}`
  }
  return { ...(expected ? { expected } : {}), styles, inconsistent, offending, message }
}
