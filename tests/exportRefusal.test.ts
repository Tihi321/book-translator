import { describe, expect, it } from 'vitest'
import { exportRefusal } from '../src/shared/protocol'

describe('exportRefusal', () => {
  it('cuts the refusal out of the message Electron wraps, and ignores other errors', () => {
    const wrapped = "Error invoking remote method 'engine:request': Error: export refused: 3 blocks untranslated"
    expect(exportRefusal(wrapped)).toBe('export refused: 3 blocks untranslated')
    expect(exportRefusal('export refused: x')).toBe('export refused: x')
    expect(exportRefusal('disk full')).toBeNull()
  })
})
