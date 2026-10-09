import JSZip from 'jszip'

/** Fixture builders: documents are generated in tests, nothing binary is committed. */

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252])
export const CSS = 'body { margin: 1em; }\nem { color: red; }\n'

const XHTML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">\n'

export async function makeEpub(): Promise<Uint8Array> {
  const zip = new JSZip()
  const put = (n: string, d: string | Uint8Array, o: JSZip.JSZipFileOptions = {}) => zip.file(n, d, { createFolders: false, ...o })
  put('mimetype', 'application/epub+zip', { compression: 'STORE' })
  put(
    'META-INF/container.xml',
    '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  )
  put(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:1234</dc:identifier>
    <dc:title>The Test Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="images/pic.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>
`
  )
  put(
    'OEBPS/nav.xhtml',
    `${XHTML_HEAD}<head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol><li><a href="text/ch%201.xhtml">Chapter One</a></li><li><a href="text/ch2.xhtml">Chapter Two</a></li></ol></nav></body></html>`
  )
  put(
    'OEBPS/toc.ncx',
    '<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><docTitle><text>The Test Book</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Chapter One</text></navLabel><content src="text/ch%201.xhtml"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>Chapter Two</text></navLabel><content src="text/ch2.xhtml"/></navPoint></navMap></ncx>'
  )
  put(
    'OEBPS/text/ch 1.xhtml',
    `${XHTML_HEAD}<head><title>Chapter One</title><link rel="stylesheet" href="../style.css"/></head>
<body>
<h1 id="c1">Chapter One</h1>
<p>Hello <em>brave</em> new <strong>world <i>of</i> books</strong>, see <a href="ch2.xhtml#x">the next chapter</a>.<br/>Second line &amp; more.</p>
<p><img src="../images/pic.png" alt="pic"/></p>
<ul><li>Plain item</li><li>Item with <b>bold</b> start<ul><li>Nested item</li></ul></li><li><p>Item with paragraph</p></li></ul>
<blockquote><p>Quoted text.</p></blockquote>
<div class="note">A div with inline<span class="sc"> children</span> only.</div>
<div><p>A div with a paragraph.</p></div>
<table><tr><th>Head</th><td>Cell <sup>1</sup></td></tr></table>
<pre>do not translate</pre>
</body></html>`
  )
  put('OEBPS/text/ch2.xhtml', `${XHTML_HEAD}<head><title>Chapter Two</title></head><body><h1>Chapter Two</h1><p>Second chapter text.</p><p>Last paragraph.</p></body></html>`)
  put('OEBPS/style.css', CSS)
  put('OEBPS/images/pic.png', PNG)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

export async function makeDocx(): Promise<Uint8Array> {
  const zip = new JSZip()
  const put = (n: string, d: string) => zip.file(n, d, { createFolders: false })
  const rpr = (inner: string) => `<w:rPr>${inner}<w:lang w:val="en-US"/></w:rPr>`
  const run = (text: string, props = '') => `<w:r>${rpr(props)}<w:t xml:space="preserve">${text}</w:t></w:r>`
  put('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
  put(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="1" w:name="_Toc1"/>${run('Chapter One')}<w:bookmarkEnd w:id="1"/></w:p>
<w:p><w:pPr><w:jc w:val="both"/></w:pPr>${run('Hello ')}${run('bold', '<w:b/>')}${run(' world and ')}${run('more bold', '<w:b/>')}<w:r>${rpr('')}<w:tab/></w:r>${run('after tab, ')}<w:hyperlink r:id="rId5">${run('a link', '<w:rStyle w:val="Hyperlink"/>')}</w:hyperlink>${run(' end')}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>
<w:p>${run('Italic start', '<w:i/>')}${run(' then plain text that is much longer than the start')}</w:p>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run('Chapter Two')}</w:p>
<w:tbl><w:tr><w:tc><w:p>${run('Cell text')}</w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t></w:t></w:r></w:p>
<w:sectPr/></w:body></w:document>`
  )
  put(
    'word/footnotes.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes ${W}><w:footnote w:id="2"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${run(' The footnote text.')}</w:p></w:footnote></w:footnotes>`
  )
  put('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr ${W}><w:p>${run('Running header')}</w:p></w:hdr>`)
  put(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-US"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`
  )
  put('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Docx Title</dc:title></cp:coreProperties>')
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

export interface PdfLine {
  text: string
  x: number
  y: number
  size: number
}

/** A minimal valid PDF (Helvetica, one content stream per page). Pass no lines on a page for an image-only (scanned) page. */
export function makePdf(pages: PdfLine[][]): Uint8Array {
  const objs: string[] = []
  const add = (s: string) => objs.push(s) // object number = index + 1
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  pages.forEach((lines, i) => {
    const content = lines.map((l) => `BT /F1 ${l.size} Tf ${l.x} ${l.y} Td (${l.text.replace(/([\\()])/g, '\\$1')}) Tj ET`).join('\n')
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}
