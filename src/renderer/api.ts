import type { BookTranslatorApi } from '../shared/protocol'

let override: BookTranslatorApi | undefined

/** The preload bridge (`window.bt`). Tests and the browser harness can replace it with `setApi`. */
export function getApi(): BookTranslatorApi {
  const api = override ?? (globalThis as unknown as { bt?: BookTranslatorApi }).bt
  if (!api) throw new Error('the Electron bridge (window.bt) is missing')
  return api
}

export function setApi(api: BookTranslatorApi | undefined): void {
  override = api
}
