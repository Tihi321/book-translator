const RTL = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv', 'ckb'])

/** True for right-to-left languages (by primary subtag: `ar`, `he-IL`, `fa`...). */
export function isRtl(lang: string | undefined): boolean {
  if (!lang) return false
  return RTL.has(lang.trim().toLowerCase().split(/[-_]/)[0]!)
}
