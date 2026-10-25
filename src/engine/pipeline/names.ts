import type { DocumentIR } from '../../shared/ir'
import type { GlossaryEntry, ProjectFile } from '../../shared/project'
import type { ProjectStore } from '../project/store'
import { normalizeTerm } from './glossary'

/** The note of a name entry made only to keep the name as it is (a project without `localizeNames`). */
export const KEEP_NAME_NOTE = 'character name: keep it as it is'

/** The note of a name entry the app added for a name the glossary builder did not give a form for. */
export const PENDING_NAME_NOTE = 'character name: no localized form yet, change Target to localize it'

/** True for a visual-novel project (a book folder or a pack) that localizes its character names. */
export const localizesNames = (project: Pick<ProjectFile, 'format' | 'settings'>): boolean =>
  (project.format === 'vn' || project.format === 'vnp') && project.settings.localizeNames === true

/** A speaker tag at the start of a block (`<1>PETRA (grumpy):</1> ...`): the name in it. */
const SPEAKER = /^<1>\**\s*([^(:*<]+?)\s*\**(?:\s*\([^)]*\))?\s*:\**\s*<\/1>/

/** `BLUE DRAGON` -> `Blue Dragon`. */
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'’.-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())

/**
 * The names of the characters of a visual novel: the bible's names, then the speakers of the script that the bible does not have, in the
 * order they first speak, in title case. A name the bible has is spelled as the bible spells it.
 */
export function characterLabels(ir: DocumentIR): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  const add = (label: string) => {
    const key = normalizeTerm(label)
    if (!key || seen.has(key)) return
    seen.add(key)
    labels.push(label)
  }
  for (const n of ir.meta.names ?? []) add(n.trim())
  for (const s of ir.sections) {
    for (const b of s.blocks) {
      const m = SPEAKER.exec(b.text)
      if (m) add(titleCase(m[1]!.trim()))
    }
  }
  return labels
}

/**
 * The names to write on export: the `person` entries of the glossary whose source is one of the labels and whose target differs, keyed by
 * the lower-cased source (the form `WriteOptions.names` takes). Empty when nothing is localized.
 */
export function nameMap(glossary: readonly GlossaryEntry[], labels: readonly string[]): Record<string, string> {
  const wanted = new Set(labels.map(normalizeTerm))
  const map: Record<string, string> = {}
  for (const e of glossary) {
    const key = normalizeTerm(e.source)
    if (e.type.trim().toLowerCase() !== 'person' || !wanted.has(key) || !e.target.trim()) continue
    if (normalizeTerm(e.target) === key) continue
    map[key] = e.target.trim()
  }
  return map
}

/** Names that two characters would share after localizing, for a warning. */
export function sharedTargets(map: Record<string, string>): { target: string; sources: string[] }[] {
  const byTarget = new Map<string, { target: string; sources: string[] }>()
  for (const [source, target] of Object.entries(map)) {
    const group = byTarget.get(normalizeTerm(target)) ?? { target, sources: [] }
    group.sources.push(source)
    byTarget.set(normalizeTerm(target), group)
  }
  return [...byTarget.values()].filter((g) => g.sources.length > 1)
}

/** An entry that only keeps a name as it is: the glossary builder may give it a localized form. */
export const isPlaceholderName = (e: GlossaryEntry): boolean => normalizeTerm(e.source) === normalizeTerm(e.target) && (e.note === KEEP_NAME_NOTE || e.note === PENDING_NAME_NOTE)

/**
 * Gives every character name that has no glossary entry yet an entry with the source as its target, so the glossary lists all of them and
 * the target can be edited. Returns how many were added.
 */
export async function ensureNameEntries(store: ProjectStore, projectId: string, ir: DocumentIR): Promise<number> {
  const glossary = await store.readGlossary(projectId)
  const have = new Set(glossary.map((e) => normalizeTerm(e.source)))
  const added: GlossaryEntry[] = characterLabels(ir)
    .filter((label) => !have.has(normalizeTerm(label)))
    .map((label) => ({ source: label, target: label, type: 'person', note: PENDING_NAME_NOTE }))
  if (added.length > 0) await store.writeGlossary(projectId, [...glossary, ...added])
  return added.length
}
