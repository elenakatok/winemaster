/**
 * BU-S3d scoring-config tests.
 *
 * Acceptance criteria:
 *   1. No configData (undefined) → byte-identical to hardcoded defaults.
 *   2. configData with explicit default prices → byte-identical.
 *   3. configData with modified prices → surplus and walk-away both shift correctly.
 *   4. Walk-away always returns 0 regardless of reservation prices in config.
 */

import { describe, it, expect } from 'vitest'
import { computeRawScore, CONFORMANCE_VECTOR } from '../src/gameDefinition'

// Representative deal outcomes
const CASE_A = { shares: 150000, vesting: 'Immediate'          as const, board_seat: true,  liability: 0      }
const CASE_B = { shares: 160000, vesting: 'Pro Rata'           as const, board_seat: true,  liability: 200000 }
const CASE_C = { shares: 155000, vesting: 'End of Second Year' as const, board_seat: false, liability: 600000 }

const DEFAULT_CONFIG = {
  winemaster_reservation_price: 7_200_000,
  home_base_reservation_price:  8_400_000,
}
const MODIFIED_CONFIG = {
  winemaster_reservation_price: 7_000_000,
  home_base_reservation_price:  8_000_000,
}

// ── Proof 1: no configData → byte-identical to hardcoded defaults ─────────────

describe('Proof 1 — no configData: results identical to hardcoded defaults', () => {
  it('CONFORMANCE_VECTOR passes without configData (same as existing conformance.test.ts)', () => {
    for (const c of CONFORMANCE_VECTOR) {
      expect(computeRawScore('winemaster', c.outcome)).toBe(c.expectedW)
      expect(computeRawScore('home_base',  c.outcome)).toBe(c.expectedH)
    }
  })

  it('Case A W: 350_000  H: 550_000', () => {
    expect(computeRawScore('winemaster', CASE_A, undefined)).toBe(350_000)
    expect(computeRawScore('home_base',  CASE_A, undefined)).toBe(550_000)
  })

  it('Case B W: 60_000  H: 1_450_000', () => {
    expect(computeRawScore('winemaster', CASE_B, undefined)).toBe(60_000)
    expect(computeRawScore('home_base',  CASE_B, undefined)).toBe(1_450_000)
  })

  it('Case C W: -1_400_000  H: 3_137_000', () => {
    expect(computeRawScore('winemaster', CASE_C, undefined)).toBe(-1_400_000)
    expect(computeRawScore('home_base',  CASE_C, undefined)).toBe(3_137_000)
  })

  it('walk-away (null) → 0 for both roles', () => {
    expect(computeRawScore('winemaster', null, undefined)).toBe(0)
    expect(computeRawScore('home_base',  null, undefined)).toBe(0)
  })
})

// ── Proof 2: explicit default prices → byte-identical to no-config ────────────

describe('Proof 2 — explicit default prices in config: same results as proof 1', () => {
  it('Case A: explicit defaults match no-configData results', () => {
    expect(computeRawScore('winemaster', CASE_A, DEFAULT_CONFIG)).toBe(350_000)
    expect(computeRawScore('home_base',  CASE_A, DEFAULT_CONFIG)).toBe(550_000)
  })

  it('Case B: explicit defaults match no-configData results', () => {
    expect(computeRawScore('winemaster', CASE_B, DEFAULT_CONFIG)).toBe(60_000)
    expect(computeRawScore('home_base',  CASE_B, DEFAULT_CONFIG)).toBe(1_450_000)
  })

  it('Case C: explicit defaults match no-configData results', () => {
    expect(computeRawScore('winemaster', CASE_C, DEFAULT_CONFIG)).toBe(-1_400_000)
    expect(computeRawScore('home_base',  CASE_C, DEFAULT_CONFIG)).toBe(3_137_000)
  })

  it('walk-away with default config → 0', () => {
    expect(computeRawScore('winemaster', null, DEFAULT_CONFIG)).toBe(0)
    expect(computeRawScore('home_base',  null, DEFAULT_CONFIG)).toBe(0)
  })
})

// ── Proof 3: modified prices → surplus and walk-away paths both shift ─────────
// Modified: WM 7.0M (−200k vs default), HB 8.0M (−400k vs default)
// WM surplus goes UP (lower reservation → easier to exceed it)
// HB surplus goes DOWN (lower reservation → less left for HB)

describe('Proof 3 — modified prices: scores shift correctly', () => {
  it('Case A WM: 550_000 (+200k vs default, lower WM reservation)', () => {
    expect(computeRawScore('winemaster', CASE_A, MODIFIED_CONFIG)).toBe(550_000)
  })
  it('Case A HB: 150_000 (−400k vs default, lower HB reservation)', () => {
    expect(computeRawScore('home_base',  CASE_A, MODIFIED_CONFIG)).toBe(150_000)
  })

  it('Case B WM: 260_000 (+200k vs default)', () => {
    expect(computeRawScore('winemaster', CASE_B, MODIFIED_CONFIG)).toBe(260_000)
  })
  it('Case B HB: 1_050_000 (−400k vs default)', () => {
    expect(computeRawScore('home_base',  CASE_B, MODIFIED_CONFIG)).toBe(1_050_000)
  })

  it('Case C WM: -1_200_000 (+200k vs default)', () => {
    expect(computeRawScore('winemaster', CASE_C, MODIFIED_CONFIG)).toBe(-1_200_000)
  })
  it('Case C HB: 2_737_000 (−400k vs default)', () => {
    expect(computeRawScore('home_base',  CASE_C, MODIFIED_CONFIG)).toBe(2_737_000)
  })

  it('walk-away → 0 even with modified prices (zero surplus = BATNA exactly met)', () => {
    expect(computeRawScore('winemaster', null, MODIFIED_CONFIG)).toBe(0)
    expect(computeRawScore('home_base',  null, MODIFIED_CONFIG)).toBe(0)
  })
})

// ── Edge: partial config — only WM price present, HB falls back to default ───

describe('Partial config — only one price present', () => {
  it('only WM price in config: WM uses config, HB falls back to default', () => {
    const partial = { winemaster_reservation_price: 7_000_000 }
    expect(computeRawScore('winemaster', CASE_A, partial)).toBe(550_000)  // uses 7.0M
    expect(computeRawScore('home_base',  CASE_A, partial)).toBe(550_000)  // falls back to 8.4M
  })

  it('invalid price type (string) falls back to default', () => {
    const bad = { winemaster_reservation_price: '7000000' as unknown as number }
    expect(computeRawScore('winemaster', CASE_A, bad)).toBe(350_000)  // uses default 7.2M
  })

  it('zero price (invalid positiveInt) falls back to default', () => {
    const zero = { winemaster_reservation_price: 0, home_base_reservation_price: 0 }
    expect(computeRawScore('winemaster', CASE_A, zero)).toBe(350_000)
    expect(computeRawScore('home_base',  CASE_A, zero)).toBe(550_000)
  })
})
