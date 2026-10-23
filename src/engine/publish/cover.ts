import { escapeXml } from './xhtml'

/** The word for "cover" in some target languages, by primary language code. Others get the translated title alone as the alt text. */
const COVER_WORD: Record<string, string> = {
  hr: 'Naslovnica',
  sr: 'Naslovnica',
  bs: 'Naslovnica',
  sl: 'Naslovnica',
  en: 'Cover',
  de: 'Umschlag',
  fr: 'Couverture',
  es: 'Portada',
  it: 'Copertina',
  pt: 'Capa',
  pl: 'Okładka',
  cs: 'Obálka',
  sk: 'Obálka',
  hu: 'Borító',
  nl: 'Omslag',
  sv: 'Omslag',
  da: 'Omslag',
  no: 'Omslag',
  ru: 'Обложка',
  uk: 'Обкладинка'
}

/** The alt text of a translated cover: "<cover word>: <title>" when the word is known for the language code, else the title alone. */
export function coverAltText(title: string, lang: string | undefined): string {
  const word = lang ? COVER_WORD[lang.trim().toLowerCase().split(/[-_]/)[0]!] : undefined
  return word ? `${word}: ${title}` : title
}

/** Breaks a text into lines of at most `max` characters, at spaces (a longer word gets its own line). */
function wrap(text: string, max: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + ' ' + w).length > max) {
      lines.push(cur)
      cur = w
    } else cur = cur ? cur + ' ' + w : w
  }
  if (cur) lines.push(cur)
  return lines
}

/** A plain title-page cover as SVG (1200x1800, light text on a dark panel): the title, a rule and the author. No fonts or images to embed. */
export function titleCoverSvg(title: string, author?: string): string {
  let size = 130
  let lines = wrap(title, Math.floor(1000 / (size * 0.55)))
  while (size > 50 && (lines.length > 6 || lines.some((l) => l.length * size * 0.55 > 1040))) {
    size -= 10
    lines = wrap(title, Math.floor(1000 / (size * 0.55)))
  }
  const lead = size * 1.25
  const top = 700 - ((lines.length - 1) * lead) / 2
  const text = lines.map((l, i) => `<text x="600" y="${Math.round(top + i * lead)}" font-size="${size}" fill="#f4efe6" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif">${escapeXml(l)}</text>`)
  const ruleY = Math.round(top + (lines.length - 1) * lead + 90)
  const by = author?.trim()
    ? wrap(author.trim(), 28).map((l, i) => `<text x="600" y="${ruleY + 140 + i * 80}" font-size="64" fill="#d8c9a8" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif">${escapeXml(l)}</text>`)
    : []
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1800" width="1200" height="1800">
<rect width="1200" height="1800" fill="#1f2a44"/>
<rect x="60" y="60" width="1080" height="1680" fill="none" stroke="#d8c9a8" stroke-width="4"/>
${text.join('\n')}
<line x1="400" y1="${ruleY}" x2="800" y2="${ruleY}" stroke="#d8c9a8" stroke-width="4"/>
${by.join('\n')}
</svg>
`
}
