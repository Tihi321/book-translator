import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { isRtl } from './lang'
import { escapeXml, xhtmlPage } from './xhtml'

/** Builds a NEW EPUB 3 (used for PDF sources, which have no layout to preserve). */

export interface EpubBlock {
  kind: 'heading' | 'para'
  /** Heading level 1-6. */
  level?: number
  /** Plain text. */
  text: string
}

export interface EpubChapter {
  title: string
  blocks: EpubBlock[]
}

export interface EpubBook {
  title: string
  author?: string
  /** Language code, e.g. `hr`. */
  language: string
  chapters: EpubChapter[]
  modified?: Date
}

export const BOOK_CSS = `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; margin: 5%; }
h1, h2, h3 { font-family: Georgia, serif; }
h1 { margin: 2em 0 1em; text-align: center; }
p { margin: 0 0 0.9em; text-indent: 0; }
`

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

function blocksHtml(blocks: EpubBlock[]): string {
  return blocks
    .map((b) => {
      if (b.kind === 'heading') {
        const l = Math.min(6, Math.max(1, b.level ?? 2))
        return `<h${l}>${escapeXml(b.text)}</h${l}>`
      }
      return `<p>${escapeXml(b.text)}</p>`
    })
    .join('\n')
}

function uuidFrom(s: string): string {
  const h = createHash('sha1').update(s).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Builds an EPUB 3 file: mimetype first and stored, container.xml, OPF, nav, chapters, CSS. */
export async function buildEpub(book: EpubBook): Promise<Uint8Array> {
  const rtl = isRtl(book.language)
  const dir = rtl ? ('rtl' as const) : undefined
  const id = `urn:uuid:${uuidFrom(book.title + '\n' + book.chapters.map((c) => c.title).join('\n'))}`
  const zip = new JSZip()
  const date = new Date(0)
  const put = (name: string, data: string, opts: JSZip.JSZipFileOptions = {}) => zip.file(name, data, { createFolders: false, date, ...opts })
  put('mimetype', 'application/epub+zip', { compression: 'STORE' })
  put(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
  )
  put('OEBPS/style.css', BOOK_CSS)

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>'
  ]
  const spine: string[] = []
  const navItems: string[] = []
  book.chapters.forEach((c, i) => {
    const n = String(i + 1).padStart(3, '0')
    const file = `chapter-${n}.xhtml`
    put(`OEBPS/${file}`, xhtmlPage(c.title, blocksHtml(c.blocks), { lang: book.language, dir, epubType: 'chapter' }))
    manifest.push(`<item id="ch${n}" href="${file}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="ch${n}"/>`)
    navItems.push(`<li><a href="${file}">${escapeXml(c.title)}</a></li>`)
  })
  put('OEBPS/nav.xhtml', xhtmlPage(book.title, `<nav epub:type="toc" id="toc">\n<ol>\n${navItems.join('\n')}\n</ol>\n</nav>`, { lang: book.language, dir }))
  put(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(book.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${id}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>${book.author ? `\n    <dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}
    <dc:language>${escapeXml(book.language)}</dc:language>
    <meta property="dcterms:modified">${iso(book.modified ?? new Date())}</meta>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine${rtl ? ' page-progression-direction="rtl"' : ''}>
    ${spine.join('\n    ')}
  </spine>
</package>
`
  )
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/epub+zip' })
}
