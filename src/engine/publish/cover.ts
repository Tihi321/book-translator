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
