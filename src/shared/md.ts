import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ZodType, z } from 'zod'

/** A markdown file split into its YAML frontmatter and its body. */
export interface MdDoc<T = Record<string, unknown>> {
  data: T
  /** Everything after the closing `---` line, byte for byte. */
  body: string
}

export class MdParseError extends Error {
  constructor(
    message: string,
    readonly source?: string
  ) {
    super(source ? `${source}: ${message}` : message)
    this.name = 'MdParseError'
  }
}

export class MdValidationError extends Error {
  constructor(
    readonly issues: readonly { path: PropertyKey[]; message: string }[],
    readonly source?: string
  ) {
    super(
      `${source ? source + ': ' : ''}invalid frontmatter\n` +
        issues.map((i) => `  - ${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('\n')
    )
    this.name = 'MdValidationError'
  }
}

const OPEN_DELIM = /^---[ \t]*\r?$/
const END_DELIM = /^(---|\.\.\.)[ \t]*\r?$/

/**
 * Splits `---` delimited frontmatter from the body. Our own splitter: tolerant of a BOM and CRLF,
 * and the body is returned untouched (only the newline that ends the closing delimiter is removed).
 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const firstNl = src.indexOf('\n')
  if (firstNl === -1 || !OPEN_DELIM.test(src.slice(0, firstNl))) return { frontmatter: null, body: src }

  const start = firstNl + 1
  let pos = start
  while (pos <= src.length) {
    const nl = src.indexOf('\n', pos)
    const lineEnd = nl === -1 ? src.length : nl
    if (END_DELIM.test(src.slice(pos, lineEnd))) {
      return { frontmatter: src.slice(start, pos), body: nl === -1 ? '' : src.slice(nl + 1) }
    }
    if (nl === -1) break
    pos = nl + 1
  }
  // No closing delimiter: treat the whole text as body.
  return { frontmatter: null, body: src }
}

/** Parses a markdown file. A file without frontmatter gets empty data. */
export function parseMd(text: string, source?: string): MdDoc {
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) return { data: {}, body }
  let data: unknown
  try {
    data = frontmatter.trim() === '' ? {} : parseYaml(frontmatter)
  } catch (err) {
    throw new MdParseError(`bad YAML frontmatter (${(err as Error).message})`, source)
  }
  if (data === null || data === undefined) data = {}
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new MdParseError('frontmatter must be a YAML mapping', source)
  }
  return { data: data as Record<string, unknown>, body }
}

/** Parses and validates the frontmatter against a zod schema. */
export function parseMdWith<S extends ZodType>(text: string, schema: S, source?: string): MdDoc<z.output<S>> {
  const doc = parseMd(text, source)
  const result = schema.safeParse(doc.data)
  if (!result.success) throw new MdValidationError(result.error.issues, source)
  return { data: result.data, body: doc.body }
}

/** Serializes frontmatter and body back to markdown text. */
export function serializeMd(data: Record<string, unknown>, body = ''): string {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined)
  const yamlText = entries.length === 0 ? '' : stringifyYaml(Object.fromEntries(entries), { lineWidth: 0 })
  return `---\n${yamlText}---\n${body}`
}
