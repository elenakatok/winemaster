import { describe, it, expect } from 'vitest'
import { computeZScoresByRole, type ScoringRecord } from '@mygames/game-engine'
import {
  computeRawScore,
  winemasterConfig,
  winemasterScoreSense,
  CONFORMANCE_VECTOR,
  WALKAWAY_HB_PLACEHOLDER,
} from '../src/gameDefinition'

// Outcomes from the spreadsheet-verified conformance vector.
const CASE1 = CONFORMANCE_VECTOR[0].outcome  // W=2_375_000, H=2_675_000
const CASE2 = CONFORMANCE_VECTOR[1].outcome  // W=3_395_000, H=2_650_000

function run(records: ScoringRecord[]) {
  return computeZScoresByRole(records, winemasterConfig, winemasterScoreSense, computeRawScore)
}

function byId(results: ReturnType<typeof run>, id: string) {
  const r = results.find(r => r.participant_id === id)
  if (!r) throw new Error(`participant ${id} not found in results`)
  return r
}

describe('Winemaster normalization', () => {

  it('normal two-role pool: sample-SD z-scores, raw unsigned for cost role', () => {
    // w1 < w2 raw → w1 lower z; h1 > h2 raw cost → h1 lower z (cost-sense).
    const records: ScoringRecord[] = [
      { participant_id: 'w1', role: 'winemaster', status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'w2', role: 'winemaster', status: 'completed', agreement_reached: true, outcome: CASE2, knowledge_check_score: null },
      { participant_id: 'h1', role: 'home_base',  status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h2', role: 'home_base',  status: 'completed', agreement_reached: true, outcome: CASE2, knowledge_check_score: null },
    ]
    const out = run(records)

    // Winemaster (value-sense, no negation). n=2, ±d from mean → z = ±1/√2.
    expect(byId(out, 'w1').raw_score).toBe(2_375_000)
    expect(byId(out, 'w2').raw_score).toBe(3_395_000)
    expect(byId(out, 'w1').normalized_score).toBeCloseTo(-0.70711, 3)
    expect(byId(out, 'w2').normalized_score).toBeCloseTo( 0.70711, 3)

    // Home base (cost-sense). H1 raw 2_675_000 > H2 raw 2_650_000 → higher cost → lower z.
    // Raw stored unsigned (library negates only for the normalizer; raw_score never negated).
    expect(byId(out, 'h1').raw_score).toBe(2_675_000)   // unsigned
    expect(byId(out, 'h2').raw_score).toBe(2_650_000)   // unsigned
    expect(byId(out, 'h1').normalized_score).toBeCloseTo(-0.70711, 3) // higher cost → worse z
    expect(byId(out, 'h2').normalized_score).toBeCloseTo( 0.70711, 3) // lower cost → better z
  })

  it('n=1 guard: single participant per role → normalized_score = 0', () => {
    const records: ScoringRecord[] = [
      { participant_id: 'w1', role: 'winemaster', status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h1', role: 'home_base',  status: 'completed', agreement_reached: true, outcome: CASE1, knowledge_check_score: null },
    ]
    const out = run(records)
    expect(byId(out, 'w1').normalized_score).toBe(0)
    expect(byId(out, 'h1').normalized_score).toBe(0)
    // Raw scores still computed and stored.
    expect(byId(out, 'w1').raw_score).toBe(2_375_000)
    expect(byId(out, 'h1').raw_score).toBe(2_675_000)
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

    // Completed participants: same z-scores as if no-show weren't in the input.
    expect(byId(out, 'w1').normalized_score).toBeCloseTo(-0.70711, 3)
    expect(byId(out, 'w2').normalized_score).toBeCloseTo( 0.70711, 3)
    // h1 alone after no_show excluded → n=1 guard → normalized=0.
    expect(byId(out, 'h1').normalized_score).toBe(0)
  })

  it('winemaster walk-away in pool (PROVISIONAL raw=0): finite z-score, not −2', () => {
    // Walk-away status='completed', outcome=null → computeRawScore('winemaster', null)=0.
    // Library does NOT exclude walk-aways; they enter the pool with their provisional raw score.
    const records: ScoringRecord[] = [
      { participant_id: 'w1',   role: 'winemaster', status: 'completed', agreement_reached: true,  outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'w_wa', role: 'winemaster', status: 'completed', agreement_reached: false, outcome: null,  knowledge_check_score: null },
    ]
    const out = run(records)

    const wa = byId(out, 'w_wa')
    expect(wa.raw_score).toBe(0)                // PROVISIONAL winemaster walk-away value
    expect(wa.normalized_score).not.toBe(-2)    // in pool, not excluded
    expect(wa.normalized_score).not.toBeNull()  // finite z-score

    // w1 (higher value) → positive z; walk-away (raw=0, lower) → negative z.
    expect(byId(out, 'w1').normalized_score).toBeGreaterThan(0)
    expect(wa.normalized_score).toBeLessThan(0)
  })

  it('home_base walk-away (PROVISIONAL sentinel): raw=WALKAWAY_HB_PLACEHOLDER, visibly wrong z', () => {
    // WALKAWAY_HB_PLACEHOLDER=1_000_000 < typical deal score 2–4M.
    // Cost-sense: lower raw cost → better z. Walk-away HB scores BETTER than deal HB.
    // This is intentionally visible — a walk-away outscoring deals is an obvious signal
    // that the provisional sentinel must be replaced.
    const records: ScoringRecord[] = [
      { participant_id: 'h1',   role: 'home_base', status: 'completed', agreement_reached: true,  outcome: CASE1, knowledge_check_score: null },
      { participant_id: 'h_wa', role: 'home_base', status: 'completed', agreement_reached: false, outcome: null,  knowledge_check_score: null },
    ]
    const out = run(records)

    const wa = byId(out, 'h_wa')
    // Raw stored unsigned (never negated in the raw_score field).
    expect(wa.raw_score).toBe(WALKAWAY_HB_PLACEHOLDER)
    expect(wa.normalized_score).not.toBe(-2)     // in pool
    expect(wa.normalized_score).not.toBeNull()

    // Walk-away scores BETTER than the deal participant — visibly wrong.
    const dealZ  = byId(out, 'h1').normalized_score!
    const walkZ  = wa.normalized_score!
    expect(walkZ).toBeGreaterThan(dealZ)
  })

})
