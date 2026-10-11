// Remembered reading position per book, in localStorage. Storage can be missing or full, so every access is guarded.
const PREFIX = 'bt.reader.pos.'

export function loadPos(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function savePos(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // ignore
  }
}

export type Theme = 'light' | 'sepia' | 'dark'

export const THEMES: Record<Theme, { bg: string; fg: string }> = {
  light: { bg: '#ffffff', fg: '#1b1b1b' },
  sepia: { bg: '#f4ecd8', fg: '#433422' },
  dark: { bg: '#1d2129', fg: '#d4d9e2' }
}
