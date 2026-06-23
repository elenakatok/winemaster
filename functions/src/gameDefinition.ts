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
  { key: 'shares',     type: 'integer', min: 0,   max: 500000  },
  { key: 'vesting',    type: 'enum',    options: ['Immediate', 'Pro Rata', 'End of Second Year'] },
  { key: 'board_seat', type: 'boolean' },
  { key: 'liability',  type: 'integer', min: 0,   max: 1000000 },
]

// ── Score sense ───────────────────────────────────────────────────────────────

/** Both roles are value-sense (higher surplus = better). */
export const winemasterScoreSense: Record<string, 'value' | 'cost'> = {
  winemaster: 'value',
  home_base:  'value',
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

/**
 * Game-supplied scoring function. The library calls this; it never inspects the formula.
 *
 * Returns surplus vs. reservation value (can be negative for losing deals).
 * Reservations: WineMaster $7,200,000 · HomeBase $8,400,000.
 *
 * Null outcome (walk-away / no deal) → 0: took the BATNA, net surplus = 0.
 * Rounding: nearest dollar at the final step only.
 */
export function computeRawScore(roleKey: string, outcome: Outcome | null): number {
  if (outcome === null) return 0  // walk-away: took BATNA, zero surplus

  const S = outcome['shares'] as number
  const V = outcome['vesting'] as VestingKey
  const B = outcome['board_seat'] as boolean
  const L = outcome['liability'] as number

  if (roleKey === 'winemaster') {
    // W = S·50·m_W(V) + (B ? seat_W(V) : 0) − 0.15·L − 7,200,000
    return Math.round(S * 50 * M_W[V] + (B ? SEAT_W[V] : 0) - 0.15 * L) - 7_200_000
  } else {
    // H = 8,400,000 − (S·50·m_H(V) + (B ? 350,000 : 0) + liab_H(L))
    return 8_400_000 - Math.round(S * 50 * M_H[V] + (B ? 350_000 : 0) + liabH(L))
  }
}

// ── Frozen conformance test vector (spreadsheet-verified ground truth) ────────

export type ConformanceCase = {
  label: string
  outcome: Outcome
  expectedW: number
  expectedH: number
}

export const CONFORMANCE_VECTOR: ConformanceCase[] = [
  {
    label: 'Case A: S=150k, Immediate, seat=yes, L=0',
    outcome: { shares: 150000, vesting: 'Immediate', board_seat: true, liability: 0 },
    expectedW:   350_000,
    expectedH:   550_000,
  },
  {
    label: 'Case B: S=160k, ProRata, seat=yes, L=200k',
    outcome: { shares: 160000, vesting: 'Pro Rata', board_seat: true, liability: 200000 },
    expectedW:    60_000,
    expectedH: 1_450_000,
  },
  {
    label: 'Case C: S=155k, EndY2, seat=no, L=600k',
    outcome: { shares: 155000, vesting: 'End of Second Year', board_seat: false, liability: 600000 },
    expectedW: -1_400_000,
    expectedH:  3_137_000,
  },
]
