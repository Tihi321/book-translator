import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isBookFolder, listDocuments } from '../src/main/folders'
import { tempDir } from './helpers'

const SOOTHER = path.resolve(__dirname, 'fixtures', 'books', 'soother')
const EXTS = ['.epub', '.txt', '.md']

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function folder(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

const names = (files: string[]) => files.map((f) => path.basename(f))

describe('listDocuments', () => {
  it('lists the documents of a folder in natural order and leaves out the rest', async () => {
    const dir = await folder()
    for (const n of ['chapter10.txt', 'chapter2.txt', 'Chapter1.MD', 'notes.docx', 'image.png']) await fs.writeFile(path.join(dir, n), 'x')
    await fs.mkdir(path.join(dir, 'plain-folder'))
    const res = await listDocuments(dir, EXTS)
    expect(names(res.files)).toEqual(['Chapter1.MD', 'chapter2.txt', 'chapter10.txt'])
    expect(res.folder).toBe(path.resolve(dir))
    expect(res.book).toBeUndefined()
  })

  it('takes a book folder as one document', async () => {
    const dir = await folder()
    const book = path.join(dir, 'soother')
    await fs.cp(SOOTHER, book, { recursive: true })
    expect(await isBookFolder(book)).toBe(true)
    expect(await listDocuments(book, EXTS)).toEqual({ folder: path.resolve(book), files: [path.resolve(book)], book: true })
  })

  it('lists the book folders inside a folder next to its documents', async () => {
    const dir = await folder()
    await fs.cp(SOOTHER, path.join(dir, 'book 2'), { recursive: true })
    await fs.cp(SOOTHER, path.join(dir, 'book 10'), { recursive: true })
    await fs.writeFile(path.join(dir, 'readme.txt'), 'x')
    const res = await listDocuments(dir, EXTS)
    expect(names(res.files)).toEqual(['book 2', 'book 10', 'readme.txt'])
    expect(res.book).toBeUndefined()
  })

  it('does not take a folder with book.md and no chapters for a book', async () => {
    const dir = await folder()
    const fake = path.join(dir, 'fake')
    await fs.mkdir(fake)
    await fs.writeFile(path.join(fake, 'book.md'), '# x')
    expect(await isBookFolder(fake)).toBe(false)
    const res = await listDocuments(fake, EXTS)
    expect(res.book).toBeUndefined()
    expect(names(res.files)).toEqual(['book.md']) // an ordinary markdown file
    expect(names((await listDocuments(dir, EXTS)).files)).toEqual([]) // and the folder is not offered as a book
  })

  it('rejects what is not a folder', async () => {
    const dir = await folder()
    const file = path.join(dir, 'a.txt')
    await fs.writeFile(file, 'x')
    await expect(listDocuments(file, EXTS)).rejects.toThrow('Not a folder')
    await expect(listDocuments('', EXTS)).rejects.toThrow('no folder')
    await expect(listDocuments(42, EXTS)).rejects.toThrow('no folder')
    await expect(listDocuments(path.join(dir, 'missing'), EXTS)).rejects.toThrow()
  })
})
