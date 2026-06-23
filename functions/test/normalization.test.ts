import { describe, it, expect } from 'vitest'
import { computeZScoresByRole, type ScoringRecord } from '@mygames/game-engine'
import {
  computeRawScore,
  winemasterConfig,
  winemasterScoreSense,
  CONFORMANCE_VECTOR,
} from '../src/gameDefinition'

// Outcomes from the B5.1 surplus-model conformance vector.
const CASE1 = CONFORMANCE_VECTOR[0].outcome  // Case A: W=+350_000,  H=+550_000
const CASE2 = CONFORMANCE_VECTOR[1].outcome  // Case B: W=+60_000,   H=+1_450_000

function run(records: ScoringRecord[]) {
  return computeZScoresByRole(records, winemasterConfig, winemasterScoreSense, computeRawScore)
}

function byId(results: ReturnType<typeof run>, id: string) {
  const r = results.find(r => r.participant_id === id)
  if (!r) throw new Error(`participant ${id} not found in results`)
  return r
}

describe('Winemaster normalization', () => {

  it('normal two-role pool: both value-sense, sample-SD z-scores', () => {
    // Both roles are value-sense (higher surplus = better).
    // w1 (Case A, W=350k) > w2 (Case B, W=60k) → w1 higher z.
    // h1 (Case A, H=550k) < h2 (Case B, H=1450k) → h1 lower z.
    const records: ScoringRecord[] = [
      { participant_id: 'w1', role: 'winemaster', status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'w2', role: 'winemaster', status: 'completed', agreement_reached: true, outcome: CASE2, knowledge_check_score: null },
      { participant_id: 'h1', role: 'home_base',  status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h2', role: 'home_base',  status: 'completed', agreement_reached: true, outcome: CASE2, knowledge_check_score: null },
    ]
    const out = run(records)

    // Winemaster: n=2, ±d from mean → z = ±1/√2 ≈ ±0.707.
    expect(byId(out, 'w1').raw_score).toBe(350_000)
    expect(byId(out, 'w2').raw_score).toBe(60_000)
    expect(byId(out, 'w1').normalized_score).toBeCloseTo( 0.70711, 3)  // higher surplus → better z
    expect(byId(out, 'w2').normalized_score).toBeCloseTo(-0.70711, 3)

    // Home base (value-sense — no cost negation). Higher surplus → better z.
    expect(byId(out, 'h1').raw_score).toBe(550_000)
    expect(byId(out, 'h2').raw_score).toBe(1_450_000)
    expect(byId(out, 'h1').normalized_score).toBeCloseTo(-0.70711, 3)  // lower surplus → worse z
    expect(byId(out, 'h2').normalized_score).toBeCloseTo( 0.70711, 3)
  })

  it('n=1 guard: single participant per role → normalized_score = 0', () => {
    const records: ScoringRecord[] = [
      { participant_id: 'w1', role: 'winemaster', status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h1', role: 'home_base',  status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
    ]
    const out = run(records)
    expect(byId(out, 'w1').normalized_score).toBe(0)
    expect(byId(out, 'h1').normalized_score).toBe(0)
    expect(byId(out, 'w1').raw_score).toBe(350_000)
    expect(byId(out, 'h1').raw_score).toBe(550_000)
  })

  it('no-show exclusion: no_show → normalized=−2, raw=null, excluded from pool stats', () => {
    const records: ScoringRecord[] = [
      { participant_id: 'w1',   role: 'winemaster', status: 'completed', agreement_reached: true,  outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'w2',   role: 'winemaster', status: 'completed', agreement_reached: true,  outcome: CASE2, knowledge_check_score: null },
      { participant_id: 'w_ns', role: 'winemaster', status: 'no_show',   agreement_reached: false, outcome: null,  knowledge_check_score: null },
      { participant_id: 'h1',   role: 'home_base',  status: 'completed', agreement_reached: true,  outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h_ns', role: 'home_base',  status: 'no_show',   agreement_reached: false, outcome: null,  knowledge_check_score: null },
    ]
    const out = run(records)

    // no_show: library sentinel values.
    expect(byId(out, 'w_ns').normalized_score).toBe(-2)
    expect(byId(out, 'w_ns').raw_score).toBeNull()
    expect(byId(out, 'h_ns').normalized_score).toBe(-2)
    expect(byId(out, 'h_ns').raw_score).toBeNull()

    // Pool stats unchanged by no-show.
    expect(byId(out, 'w1').normalized_score).toBeCloseTo( 0.70711, 3)
    expect(byId(out, 'w2').normalized_score).toBeCloseTo(-0.70711, 3)
    // h1 alone after no_show excluded → n=1 guard → normalized=0.
    expect(byId(out, 'h1').normalized_score).toBe(0)
  })

  it('walk-away in pool: raw=0 (domain-confirmed floor), scores below deals (correct direction)', () => {
    // Walk-away → raw=0 (took BATNA, zero surplus). Both roles.
    // Library does NOT exclude walk-aways; they enter the pool on raw=0.

    // Winemaster: Case A deal (W=+350k) vs. walk-away (raw=0).
    const wRecords: ScoringRecord[] = [
      { participant_id: 'w1',   role: 'winemaster', status: 'completed', agreement_reached: true,  outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'w_wa', role: 'winemaster', status: 'completed', agreement_reached: false, outcome: null,  knowledge_check_score: null },
    ]
    const wOut = run(wRecords)
    const wWa = byId(wOut, 'w_wa')
    expect(wWa.raw_score).toBe(0)
    expect(wWa.normalized_score).not.toBe(-2)    // in pool, not excluded
    expect(wWa.normalized_score).not.toBeNull()
    expect(byId(wOut, 'w1').normalized_score).toBeGreaterThan(0)  // deal scores above mean
    expect(wWa.normalized_score).toBeLessThan(0)                  // walk-away scores below mean

    // Home base: Case A deal (H=+550k) vs. walk-away (raw=0).
    // Value-sense: 0 < 550k → walk-away gets lower z. Correct direction.
    const hRecords: ScoringRecord[] = [
      { participant_id: 'h1',   role: 'home_base', status: 'completed', agreement_reached: true,  outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h_wa', role: 'home_base', status: 'completed', agreement_reached: false, outcome: null,  knowledge_check_score: null },
    ]
    const hOut = run(hRecords)
    const hWa = byId(hOut, 'h_wa')
    expect(hWa.raw_score).toBe(0)
    expect(hWa.normalized_score).not.toBe(-2)    // in pool
    expect(hWa.normalized_score).not.toBeNull()
    expect(byId(hOut, 'h1').normalized_score).toBeGreaterThan(0)  // deal above mean
    expect(hWa.normalized_score).toBeLessThan(0)                  // walk-away below mean — correct
  })

})
