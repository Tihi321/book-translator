export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function xhtmlPage(title: string, bodyHtml: string, opts: { lang: string; dir?: 'rtl'; css?: string; epubType?: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(opts.lang)}" xml:lang="${escapeXml(opts.lang)}"${opts.dir ? ` dir="${opts.dir}"` : ''}>
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="${opts.css ?? 'style.css'}"/>
</head>
<body${opts.epubType ? ` epub:type="${opts.epubType}"` : ''}>
${bodyHtml}
</body>
</html>
`
}
