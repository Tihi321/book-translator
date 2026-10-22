import { statSync } from 'node:fs'
import path from 'node:path'
import type { DocFormat, FormatAdapter } from '../../shared/ir'
import { hashFile } from '../project/store'
import { docxAdapter } from './docx'
import { epubAdapter } from './epub'
import { pdfAdapter } from './pdf'
import { textAdapter } from './text'
import { hashVnFolder, isVnFolder, VN_BRIEF_NOTE, VN_BRIEF_NOTE_LOCALIZED, vnAdapter } from './vn'

interface Registration {
  format: DocFormat
  extensions: string[]
  adapter: FormatAdapter
}

const REGISTRY: Registration[] = [
  { format: 'txt', extensions: ['.txt'], adapter: textAdapter },
  { format: 'md', extensions: ['.md', '.markdown'], adapter: textAdapter },
  { format: 'epub', extensions: ['.epub'], adapter: epubAdapter },
  { format: 'docx', extensions: ['.docx'], adapter: docxAdapter },
  { format: 'pdf', extensions: ['.pdf'], adapter: pdfAdapter }
]

export function supportedExtensions(): string[] {
  return REGISTRY.flatMap((r) => r.extensions)
}

/** The format for a file name (or a visual-novel book folder), or undefined if no adapter handles it. */
export function formatOf(file: string): DocFormat | undefined {
  if (isVnFolder(file)) return 'vn'
  const ext = path.extname(file).toLowerCase()
  return REGISTRY.find((r) => r.extensions.includes(ext))?.format
}

/** The adapter for a file, chosen by extension, or the folder adapter for a Scriptorium book folder. Throws for an unsupported type. */
export function adapterFor(file: string): FormatAdapter {
  if (isVnFolder(file)) return vnAdapter
  if (isDirectory(file)) throw new Error(`"${file}" is a folder but not a visual-novel book folder (it needs book.md and chapters/)`)
  const ext = path.extname(file).toLowerCase()
  const reg = REGISTRY.find((r) => r.extensions.includes(ext))
  if (!reg) throw new Error(`unsupported file type "${ext || file}" (supported: ${supportedExtensions().join(', ')}, or a visual-novel book folder)`)
  return reg.adapter
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory()
  } catch {
    return false
  }
}

/** sha256 of a source: the file, or the files of a book folder. */
export async function hashSource(file: string): Promise<string> {
  return isVnFolder(file) ? hashVnFolder(file) : hashFile(file)
}

/** What every agent is told about a format, after the book brief (the visual-novel script rules). */
export function formatNote(format: DocFormat, opts: { localizeNames?: boolean } = {}): string | undefined {
  return format === 'vn' ? (opts.localizeNames ? VN_BRIEF_NOTE_LOCALIZED : VN_BRIEF_NOTE) : undefined
}

/** The book brief with the format's note. */
export function briefWithNote(brief: string, format: DocFormat, opts: { localizeNames?: boolean } = {}): string {
  const note = formatNote(format, opts)
  return note ? [brief.trim(), note].filter(Boolean).join('\n\n') : brief
}
