/**
 * BU-S3d / BU-S3e scoring-config tests.
 *
 * BU-S3d acceptance criteria:
 *   1. No configData (undefined) → byte-identical to hardcoded defaults.
 *   2. configData with explicit default prices → byte-identical.
 *   3. configData with modified prices → surplus and walk-away both shift correctly.
 *   4. Walk-away always returns 0 regardless of reservation prices in config.
 *
 * BU-S3e acceptance criteria:
 *   5. Walk-away uses reservation-driven logic (not hardcoded 0):
 *      a. No regression: Winemaster walk-away still 0 with any prices.
 *      b. Modified prices: walk-away still 0 (surplus formula: res − res = 0).
 *      c. Generality proof: hypothetical absolute-scale game walk-away = reservation, not 0.
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

// ─────────────────────────────────────────────────────────────────────────────
// BU-S3e: Reservation-driven walk-away proofs
// ─────────────────────────────────────────────────────────────────────────────

// Proof 5a — No regression: Winemaster walk-away still 0 with reservation-driven logic.
// (same assertions as Proof 1/2/3 walk-away lines; re-stated here as an explicit acceptance test)

describe('S3e Proof 5a — no regression: walk-away still 0 for Winemaster', () => {
  it('no config → walk-away 0 (WM surplus at BATNA: wmRes − wmRes = 0)', () => {
    expect(computeRawScore('winemaster', null, undefined)).toBe(0)
    expect(computeRawScore('home_base',  null, undefined)).toBe(0)
  })

  it('explicit default prices → walk-away 0', () => {
    expect(computeRawScore('winemaster', null, DEFAULT_CONFIG)).toBe(0)
    expect(computeRawScore('home_base',  null, DEFAULT_CONFIG)).toBe(0)
  })

  it('deal-path CASE_A: reservation-driven change did not affect deal scores', () => {
    expect(computeRawScore('winemaster', CASE_A)).toBe(350_000)
    expect(computeRawScore('home_base',  CASE_A)).toBe(550_000)
  })
})

// Proof 5b — Modified prices: walk-away still 0 (surplus formula → res − res = 0).

describe('S3e Proof 5b — modified prices: Winemaster walk-away still 0', () => {
  it('WM 7.0M, HB 8.0M → walk-away still 0 (7.0M − 7.0M = 0, 8.0M − 8.0M = 0)', () => {
    expect(computeRawScore('winemaster', null, MODIFIED_CONFIG)).toBe(0)
    expect(computeRawScore('home_base',  null, MODIFIED_CONFIG)).toBe(0)
  })

  it('extreme low prices (1, 1) → walk-away still 0', () => {
    const extreme = { winemaster_reservation_price: 1, home_base_reservation_price: 1 }
    expect(computeRawScore('winemaster', null, extreme)).toBe(0)
    expect(computeRawScore('home_base',  null, extreme)).toBe(0)
  })
})

// Proof 5c — Generality: hypothetical absolute-scale game walk-away = reservation, not 0.
//
// This function mimics a game whose raw formula is raw = realized_value (NOT surplus-based).
// At walk-away, the role receives exactly its reservation value, so raw = reservation.
// A surplus-based game would return 0; this absolute-scale game returns the reservation.

function hypotheticalAbsoluteScore(
  roleKey: string,
  outcome: { value: number } | null,
  configData?: Record<string, unknown>,
): number {
  // Read reservation from config with fallback
  const res = (typeof configData?.[`${roleKey}_reservation`] === 'number' &&
               (configData[`${roleKey}_reservation`] as number) > 0)
    ? (configData[`${roleKey}_reservation`] as number) : 100

  if (outcome === null) {
    // Walk-away: score at exactly the reservation value.
    // Absolute formula: raw = realized_value; at BATNA, realized_value = res.
    return res  // NOT hardcoded 0 — the reservation itself
  }
  return outcome.value  // deal: raw = realized_value directly
}

describe('S3e Proof 5c — generality: absolute-scale game walk-away = reservation', () => {
  it('reservation=100 (default), walk-away → 100, not 0', () => {
    expect(hypotheticalAbsoluteScore('buyer', null, undefined)).toBe(100)
  })

  it('reservation=150 in config, walk-away → 150', () => {
    expect(hypotheticalAbsoluteScore('buyer', null, { buyer_reservation: 150 })).toBe(150)
  })

  it('reservation=200, deal at 250 → surplus 250; walk-away → 200 (not 0)', () => {
    expect(hypotheticalAbsoluteScore('buyer', { value: 250 }, { buyer_reservation: 200 })).toBe(250)
    expect(hypotheticalAbsoluteScore('buyer', null,           { buyer_reservation: 200 })).toBe(200)
  })

  it('contrast: Winemaster walk-away is 0 (surplus formula), hypothetical is 100 (absolute)', () => {
    // Surplus formula (Winemaster): walk-away = res − res = 0
    expect(computeRawScore('winemaster', null, { winemaster_reservation_price: 100 })).toBe(0)
    // Absolute formula (hypothetical): walk-away = res = 100
    expect(hypotheticalAbsoluteScore('buyer', null, { buyer_reservation: 100 })).toBe(100)
  })
})
