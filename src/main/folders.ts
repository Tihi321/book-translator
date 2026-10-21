import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FolderListing } from '../shared/protocol'

/**
 * True for a folder with `book.md` and a `chapters/` folder (a Scriptorium visual-novel book). The same test as `isVnFolder` in
 * src/engine/formats/vn.ts, repeated here because the main process does not import the engine.
 */
export async function isBookFolder(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory() && (await stat(path.join(dir, 'book.md'))).isFile() && (await stat(path.join(dir, 'chapters'))).isDirectory()
  } catch {
    return false
  }
}

/**
 * What a folder offers to translate. A book folder is one document (`book: true`, the folder itself). Any other folder gives its documents
 * (`extensions`, lower case with the dot) at the top level and its subfolders that are book folders, in natural name order (chapter2 before chapter10).
 */
export async function listDocuments(dir: unknown, extensions: readonly string[]): Promise<FolderListing> {
  if (typeof dir !== 'string' || !dir) throw new Error('no folder')
  const folder = path.resolve(dir)
  if (!(await stat(folder)).isDirectory()) throw new Error('Not a folder')
  if (await isBookFolder(folder)) return { folder, files: [folder], book: true }
  const exts = new Set(extensions.map((e) => e.toLowerCase()))
  const names: string[] = []
  for (const e of await readdir(folder, { withFileTypes: true })) {
    if (e.isFile() ? exts.has(path.extname(e.name).toLowerCase()) : e.isDirectory() && (await isBookFolder(path.join(folder, e.name)))) names.push(e.name)
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return { folder, files: names.map((n) => path.join(folder, n)) }
}
