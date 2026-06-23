import { describe, it, expect } from 'vitest'
import { computeRawScore, CONFORMANCE_VECTOR } from '../src/gameDefinition'

describe('Winemaster scoring conformance', () => {
  for (const c of CONFORMANCE_VECTOR) {
    it(c.label, () => {
      expect(computeRawScore('winemaster', c.outcome)).toBe(c.expectedW)
      expect(computeRawScore('home_base', c.outcome)).toBe(c.expectedH)
    })
  }
})
