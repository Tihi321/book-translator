import path from 'node:path'
import type { DocFormat, FormatAdapter } from '../../shared/ir'
import { docxAdapter } from './docx'
import { epubAdapter } from './epub'
import { pdfAdapter } from './pdf'
import { textAdapter } from './text'

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

/** The format for a file name, or undefined if no adapter handles it. */
export function formatOf(file: string): DocFormat | undefined {
  const ext = path.extname(file).toLowerCase()
  return REGISTRY.find((r) => r.extensions.includes(ext))?.format
}

/** The adapter for a file, chosen by extension. Throws for an unsupported type. */
export function adapterFor(file: string): FormatAdapter {
  const ext = path.extname(file).toLowerCase()
  const reg = REGISTRY.find((r) => r.extensions.includes(ext))
  if (!reg) throw new Error(`unsupported file type "${ext || file}" (supported: ${supportedExtensions().join(', ')})`)
  return reg.adapter
}
