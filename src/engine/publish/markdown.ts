import { promises as fs } from 'node:fs'
import type { DocumentIR } from '../../shared/ir'
import { stripTags } from '../formats/inline'

function escapeLineStart(text: string): string {
  return /^(#|>|[-*+][ \t]|\d+[.)][ \t])/.test(text) ? '\\' + text : text
}

/** Markdown text for an IR (used for PDF sources): headings as `#`, paragraphs separated by blank lines. Untranslated blocks keep the source. */
export function irToMarkdown(ir: DocumentIR, translations: Map<string, string>): string {
  const parts: string[] = []
  for (const s of ir.sections) {
    for (const b of s.blocks) {
      const text = stripTags(translations.get(b.id) ?? b.text).trim()
      if (!text) continue
      if (b.kind === 'heading') parts.push('#'.repeat(Math.min(6, Math.max(1, b.level ?? 2))) + ' ' + text.replace(/\s+/g, ' '))
      else parts.push(escapeLineStart(text))
    }
  }
  return parts.join('\n\n') + '\n'
}

export async function writeMarkdown(ir: DocumentIR, translations: Map<string, string>, outPath: string): Promise<void> {
  await fs.writeFile(outPath, irToMarkdown(ir, translations), 'utf8')
}
