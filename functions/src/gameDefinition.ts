import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'

// ── Role config ───────────────────────────────────────────────────────────────

export const winemasterConfig: RoleConfig = {
  roles: [
    { key: 'winemaster', label: 'Winemaster', short: 'W' },
    { key: 'home_base',  label: 'Home Base',  short: 'H' },
  ],
}

// ── Outcome schema ────────────────────────────────────────────────────────────

export const winemasterSchema: OutcomeSchema = [
  { key: 'shares',     type: 'integer', min: 0,   max: 100000  },
  { key: 'vesting',    type: 'enum',    options: ['Immediate', 'Pro Rata', 'End of Second Year'] },
  { key: 'board_seat', type: 'boolean' },
  { key: 'liability',  type: 'integer', min: 0,   max: 1000000 },
]

// ── Score sense ───────────────────────────────────────────────────────────────

/** Winemaster: value role (higher = better). Home Base: cost role (lower = better). */
export const winemasterScoreSense: Record<string, 'value' | 'cost'> = {
  winemaster: 'value',
  home_base:  'cost',
}

// ── Scoring formulas (spec §8b) ───────────────────────────────────────────────

type VestingKey = 'Immediate' | 'Pro Rata' | 'End of Second Year'

const M_W: Record<VestingKey, number> = {
  'Immediate':          1.00,
  'Pro Rata':           0.88,
  'End of Second Year': 0.76,
}

const SEAT_W: Record<VestingKey, number> = {
  'Immediate':           50000,
  'Pro Rata':           250000,
  'End of Second Year': 750000,
}

const M_H: Record<VestingKey, number> = {
  'Immediate':          1.00,
  'Pro Rata':           0.81,
  'End of Second Year': 0.64,
}

function liabH(l: number): number {
  // Piecewise: continuous at the kink point L=500000 (both expressions give 300000 there).
  return l <= 500000
    ? 0.6 * l
    : 0.6 * (0.95 * 500000 + 0.05 * l)
}

// PROVISIONAL — home_base walk-away cost sentinel. Real no-deal payoff pending from Gary (B5).
// Typical deal scores are 2–4M. At 1_000_000 this is LOWER than any real deal, so cost-sense
// negation makes a walk-away HB score BETTER than deal HB — visibly wrong if it ships unreplaced.
// Swap in Gary's value and add a conformance case; see swap-in checklist at bottom of file.
export const WALKAWAY_HB_PLACEHOLDER = 1_000_000

/**
 * Game-supplied scoring function. The library calls this; it never inspects the formula.
 *
 * Returns raw score (always positive for both roles; the library's sign convention
 * negates home_base before z-scoring — not here).
 *
 * Null outcome (walk-away / no deal) → PROVISIONAL values; see B5 notes.
 * Rounding: nearest dollar at the final step only.
 */
export function computeRawScore(roleKey: string, outcome: Outcome | null): number {
  if (outcome === null) {
    // PROVISIONAL — walk-away raw payoff pending from Gary; see B5 notes.
    if (roleKey === 'winemaster') {
      return 0  // 0 = no value gained; plausibly worst on a value axis, but not domain-confirmed.
    }
    // home_base (cost-sense): 0 would be best possible cost — WRONG for a walk-away.
    // Using WALKAWAY_HB_PLACEHOLDER so mis-scored data is visibly wrong, not plausibly wrong.
    return WALKAWAY_HB_PLACEHOLDER
  }

  const S = outcome['shares'] as number
  const V = outcome['vesting'] as VestingKey
  const B = outcome['board_seat'] as boolean
  const L = outcome['liability'] as number

  if (roleKey === 'winemaster') {
    // W = S·50·m_W(V) + (B ? seat_W(V) : 0) − 0.15·L
    return Math.round(S * 50 * M_W[V] + (B ? SEAT_W[V] : 0) - 0.15 * L)
  } else {
    // H = S·50·m_H(V) + (B ? 350000 : 0) + liab_H(L)
    return Math.round(S * 50 * M_H[V] + (B ? 350_000 : 0) + liabH(L))
  }
}

// ── Frozen conformance test vector (spreadsheet-verified ground truth) ────────

export type ConformanceCase = {
  label: string
  outcome: Outcome
  expectedW: number
  expectedH: number
}

// ── B5 walk-away swap-in checklist (once Gary provides real no-deal payoffs) ──────────────────
// 1. Replace WALKAWAY_HB_PLACEHOLDER with Gary's home_base no-deal payoff (same file, above).
// 2. If winemaster no-deal payoff ≠ 0, update the winemaster branch in computeRawScore (above).
// 3. Add two new entries to CONFORMANCE_VECTOR below:
//      { label: 'WalkawayW: outcome=null', outcome: null, expectedW: <Gary's value>, expectedH: N/A }
//      { label: 'WalkawayH: outcome=null', outcome: null, expectedW: N/A, expectedH: <Gary's value> }
//    (Or one combined case if both roles share a single no-deal payoff formula.)
// 4. Re-run `npm test` in functions/ — conformance.test.ts and normalization.test.ts must both pass.
// That's it. finalizeInstance.ts and the library need no changes.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const CONFORMANCE_VECTOR: ConformanceCase[] = [
  {
    label: 'Case 1: S=50k, ProRata, seat=yes, L=500k',
    outcome: { shares: 50000, vesting: 'Pro Rata', board_seat: true, liability: 500000 },
    expectedW: 2_375_000,
    expectedH: 2_675_000,
  },
  {
    label: 'Case 2: S=70k, EndY2, seat=yes, L=100k',
    outcome: { shares: 70000, vesting: 'End of Second Year', board_seat: true, liability: 100000 },
    expectedW: 3_395_000,
    expectedH: 2_650_000,
  },
  {
    label: 'Case 3: S=70k, Immediate, seat=no, L=700k',
    outcome: { shares: 70000, vesting: 'Immediate', board_seat: false, liability: 700000 },
    expectedW: 3_395_000,
    expectedH: 3_806_000,
  },
]
