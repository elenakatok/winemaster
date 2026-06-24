import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition } from '@mygames/game-server'

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

// Defaults match the spec-locked reservation values.
const WM_RESERVATION_DEFAULT = 7_200_000
const HB_RESERVATION_DEFAULT = 8_400_000

function readReservation(configData: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = configData?.[key]
  return (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) ? v : fallback
}

/**
 * Game-supplied scoring function. The library calls this; it never inspects the formula.
 *
 * Returns surplus vs. reservation value (can be negative for losing deals).
 * Default reservations: WineMaster $7,200,000 · HomeBase $8,400,000.
 * configData overrides these if the instructor has saved custom values in Settings.
 *
 * Walk-away (null outcome): scored at exactly the reservation value.
 * Winemaster's formulas are surplus-based (realized − reservation), so at BATNA the
 * realized value equals the reservation and the surplus is 0. That 0 comes from the
 * formula, not a hardcoded constant — ensuring a future non-surplus game gets the
 * correct non-zero walk-away score automatically.
 * Rounding: nearest dollar at the final step only.
 */
export function computeRawScore(roleKey: string, outcome: Outcome | null, configData?: Record<string, unknown>): number {
  const wmRes = readReservation(configData, 'winemaster_reservation_price', WM_RESERVATION_DEFAULT)
  const hbRes = readReservation(configData, 'home_base_reservation_price',  HB_RESERVATION_DEFAULT)

  if (outcome === null) {
    // Walk-away: score as if realized exactly the reservation value.
    //   WM surplus formula: realized_value − wmRes → wmRes − wmRes = 0
    //   HB surplus formula: hbRes − cost         → hbRes − hbRes = 0
    const walkAwayValue = roleKey === 'winemaster' ? wmRes : hbRes
    return roleKey === 'winemaster' ? walkAwayValue - wmRes : hbRes - walkAwayValue
  }

  const S = outcome['shares'] as number
  const V = outcome['vesting'] as VestingKey
  const B = outcome['board_seat'] as boolean
  const L = outcome['liability'] as number

  if (roleKey === 'winemaster') {
    // W = S·50·m_W(V) + (B ? seat_W(V) : 0) − 0.15·L − wmRes
    return Math.round(S * 50 * M_W[V] + (B ? SEAT_W[V] : 0) - 0.15 * L) - wmRes
  } else {
    // H = hbRes − (S·50·m_H(V) + (B ? 350,000 : 0) + liab_H(L))
    return hbRes - Math.round(S * 50 * M_H[V] + (B ? 350_000 : 0) + liabH(L))
  }
}

// ── GameDefinition (full contract for game-server factories) ─────────────────

export const winemasterGameDef: GameDefinition = {
  game_id: 'winemaster',
  roles:   winemasterConfig,
  scoreSense: winemasterScoreSense,
  composition: { winemaster: 2, home_base: 2 },
  outcomeSchema: winemasterSchema,
  computeRawScore,
  reservations: { winemaster: 7_200_000, home_base: 8_400_000 },
  corsOrigins: ['https://winemaster.mygames.live'],
  classroom: { callbackSecretId: 'CLASSROOM_CALLBACK_SECRET' },
  // perRoleCap omitted → factory uses eligible.length (no cap, place every extra).
  // deadlockThreshold omitted → factory defaults to 5 (Winemaster's value).

  // Settings page config fields.
  // Role name defaults match the role labels declared above.
  // Reservation price defaults match the spec-locked values used in computeRawScore.
  configFields: [
    { key: 'winemaster_role_name',         kind: 'string',      default: 'Winemaster'  },
    { key: 'home_base_role_name',          kind: 'string',      default: 'Home Base'   },
    { key: 'winemaster_reservation_price', kind: 'positiveInt', default: 7_200_000     },
    { key: 'home_base_reservation_price',  kind: 'positiveInt', default: 8_400_000     },
    { key: 'winemaster_sheet_url',          kind: 'url',         default: '/role-info/winemaster.pdf'           },
    { key: 'winemaster_worksheet_url',     kind: 'url',         default: '/role-info/winemasterWorksheet.xlsx' },
    { key: 'home_base_sheet_url',          kind: 'url',         default: '/role-info/homebase.pdf'             },
    { key: 'home_base_worksheet_url',      kind: 'url',         default: '/role-info/homebaseWorksheet.xlsx'   },
  ],

  prepDefaults: [
    // ── Q1: Role-identification gate (system, one per role) ──────────────────
    {
      field: 'kc_gate_winemaster', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'winemaster',
      prompt: 'What is your role in this negotiation?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'winemaster', label: 'WineMaster — co-founder, one-third owner, and senior manager of the company being sold' },
        { value: 'home_base',  label: 'HomeBase — member of the business development team acquiring an online wine vendor' },
      ],
      explanation: 'You are WineMaster. You and your two partners are negotiating the sale of your company to HomeBase.',
    },
    {
      field: 'kc_gate_home_base', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'home_base',
      prompt: 'What is your role in this negotiation?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'winemaster', label: 'WineMaster — co-founder, one-third owner, and senior manager of the company being sold' },
        { value: 'home_base',  label: 'HomeBase — member of the business development team acquiring an online wine vendor' },
      ],
      explanation: 'You are HomeBase. You are negotiating to acquire WineMaster from its founders.',
    },

    // ── Q2–Q5: Graded MC — Winemaster role ──────────────────────────────────
    {
      field: 'kc_wm_scarcity', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'scarcity', role_target: 'winemaster',
      prompt: 'Early in the meeting, before any numbers are on the table, you mention to the HomeBase team that two other suitors are actively circling WineMaster and that one of them has already put a definite offer in writing. By signaling that the company is wanted elsewhere and may not stay available, which tactic are you primarily using to strengthen your claim on value?',
      placeholder: '', order: 10, hidden: false, deletable: false,
      options: [
        { value: 'reciprocation',     label: 'Reciprocation' },
        { value: 'consistency',       label: 'Consistency' },
        { value: 'social_validation', label: 'Social validation' },
        { value: 'liking',            label: 'Liking' },
        { value: 'authority',         label: 'Authority' },
        { value: 'scarcity',          label: 'Scarcity' },
      ],
      explanation: 'Making WineMaster appear less available — other buyers, time pressure — raises its perceived value to HomeBase. That is the scarcity tactic.',
    },
    {
      field: 'kc_wm_reciprocation', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'reciprocation', role_target: 'winemaster',
      prompt: 'You ask for the board seat and immediate vesting and full transfer of the lawsuit to HomeBase. When they balk, you drop the board-seat demand "as a gesture," expecting them to give ground on vesting in return. Which tactic does this concession-then-expect-a-concession move rely on?',
      placeholder: '', order: 11, hidden: false, deletable: false,
      options: [
        { value: 'reciprocation',     label: 'Reciprocation' },
        { value: 'authority',         label: 'Authority' },
        { value: 'scarcity',          label: 'Scarcity' },
        { value: 'social_validation', label: 'Social validation' },
        { value: 'consistency',       label: 'Consistency' },
      ],
      explanation: 'A concession on your side creates social pressure for a return concession — the "reject-then-retreat" dynamic. That is reciprocation.',
    },
    {
      field: 'kc_wm_objective_criteria', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'joint_standard', role_target: 'winemaster',
      prompt: 'HomeBase opens by saying, "We\'ll give you 150,000 shares, and that\'s where we are." Rather than counter with your own number, you respond, "How did you arrive at that figure?" Why is asking for the reasoning behind their number the stronger move?',
      placeholder: '', order: 12, hidden: false, deletable: false,
      options: [
        { value: 'split_diff',        label: 'It signals you\'re willing to split the difference' },
        { value: 'joint_standard',    label: 'It reframes the issue as a joint search for a fair standard rather than a contest of wills' },
        { value: 'commits_position',  label: 'It commits them to their position more firmly' },
        { value: 'concedes_starting', label: 'It concedes that their number is the starting point' },
      ],
      explanation: 'Asking for their theory shifts the negotiation off positional bargaining and toward deciding the matter on objective criteria.',
    },
    {
      field: 'kc_wm_principled', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'decline_link', role_target: 'winemaster',
      prompt: 'HomeBase says, "We came up on vesting last round — it\'s your turn to come up on the lawsuit." How does a principled negotiator respond to this kind of horse-trading?',
      placeholder: '', order: 13, hidden: false, deletable: false,
      options: [
        { value: 'agree_reciprocate',  label: 'Agree, since reciprocating concessions keeps things fair' },
        { value: 'counter_concession', label: 'Counter with a concession of equal size on a different issue' },
        { value: 'decline_link',       label: 'Decline to link the issues and insist each be settled on its own merits and relevant standard' },
        { value: 'hold_firm',          label: 'Hold firm on both and refuse to discuss further' },
      ],
      explanation: 'A concession on one issue has nothing to do with the right answer on another; you settle each on the merits, yielding only to principle, never to pressure.',
    },

    // ── Q2–Q5: Graded MC — HomeBase role ────────────────────────────────────
    {
      field: 'kc_hb_scarcity', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'scarcity', role_target: 'home_base',
      prompt: 'The WineMaster founders keep emphasizing that other buyers are interested and that they "want to move quickly." Recognizing this as an attempt to make the company feel less available and drive your price up, which persuasion tactic are they deploying against you?',
      placeholder: '', order: 10, hidden: false, deletable: false,
      options: [
        { value: 'reciprocation',     label: 'Reciprocation' },
        { value: 'consistency',       label: 'Consistency' },
        { value: 'social_validation', label: 'Social validation' },
        { value: 'liking',            label: 'Liking' },
        { value: 'authority',         label: 'Authority' },
        { value: 'scarcity',          label: 'Scarcity' },
      ],
      explanation: 'The "others are interested, decide soon" framing is a scarcity play to inflate WineMaster\'s perceived value.',
    },
    {
      field: 'kc_hb_consistency', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'consistency', role_target: 'home_base',
      prompt: 'You get WineMaster to agree early that the deal should be priced off the comparable-transaction multiples. Later, when they push for a higher share count on a different rationale, you hold them to the standard they already endorsed. Which principle lets you use their earlier agreement as leverage?',
      placeholder: '', order: 11, hidden: false, deletable: false,
      options: [
        { value: 'reciprocation',     label: 'Reciprocation' },
        { value: 'consistency',       label: 'Consistency' },
        { value: 'liking',            label: 'Liking' },
        { value: 'social_validation', label: 'Social validation' },
        { value: 'scarcity',          label: 'Scarcity' },
      ],
      explanation: 'Their public commitment to the benchmark constrains them from abandoning it later — the consistency principle.',
    },
    {
      field: 'kc_hb_objective_criteria', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'ask_joint_search', role_target: 'home_base',
      prompt: 'The WineMaster founders name a share count and, when pressed, justify it by pointing to recent comparable acquisitions. Before countering, what\'s the most principled first step?',
      placeholder: '', order: 12, hidden: false, deletable: false,
      options: [
        { value: 'reject_state_own',  label: 'Reject the number and state your own as company policy' },
        { value: 'ask_joint_search',  label: 'Ask how they derived it, then treat the question as a joint search for the fairest standard' },
        { value: 'split_diff',        label: 'Offer to split the difference immediately' },
        { value: 'match_opposite',    label: 'Match their number with an equal and opposite demand' },
      ],
      explanation: 'Ask for the theory behind their figure and frame the issue as jointly finding a fair criterion rather than trading positions.',
    },
    {
      field: 'kc_hb_principled', type: 'mc', system: false,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'static', correct_value: 'separate_merits', role_target: 'home_base',
      prompt: 'A founder says, "Come on — you trust us, don\'t you?" while pushing you to drop your liability position. What\'s the principled response?',
      placeholder: '', order: 13, hidden: false, deletable: false,
      options: [
        { value: 'concede_trust',   label: 'Concede, since trust is essential to the future relationship' },
        { value: 'separate_merits', label: 'Treat trust as a separate matter and settle the liability on its merits and the relevant standard' },
        { value: 'walk_away',       label: 'Walk away from the deal' },
        { value: 'match_appeal',    label: 'Match the appeal by questioning their good faith' },
      ],
      explanation: 'A manipulative appeal to trust is a form of pressure; the principled move keeps the substantive issue tied to objective criteria, not to the relationship.',
    },

    // ── Q6–Q8: Reflection (prep phase, free-response, deletable) ─────────────
    {
      field: 'prep_wm_batna', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'winemaster',
      prompt: 'What is your BATNA? Your walk-away in this negotiation? Why?',
      placeholder: '', order: 20, hidden: false, deletable: true,
    },
    {
      field: 'prep_wm_objective_standards', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'winemaster',
      prompt: 'What other objective standards could legitimately bear on the four open issues (share count, vesting, board seat, lawsuit)? List the ones you\'d come to the table prepared to invoke.',
      placeholder: '', order: 21, hidden: false, deletable: true,
    },
    {
      field: 'prep_wm_vulnerability', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'winemaster',
      prompt: 'HomeBase will likely use these same persuasion tactics on you. Which one are you personally most vulnerable to in this negotiation, and what will you do in the room to keep it from moving you off your numbers?',
      placeholder: '', order: 22, hidden: false, deletable: true,
    },
    {
      field: 'prep_hb_batna', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'home_base',
      prompt: 'What is your BATNA? Your walk-away in this negotiation? Why?',
      placeholder: '', order: 20, hidden: false, deletable: true,
    },
    {
      field: 'prep_hb_objective_standards', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'home_base',
      prompt: 'What other objective standards could legitimately bear on the four open issues (share count, vesting, board seat, lawsuit)? List the ones you\'d come to the table prepared to invoke.',
      placeholder: '', order: 21, hidden: false, deletable: true,
    },
    {
      field: 'prep_hb_vulnerability', type: 'text', system: false,
      category: 'preparation', format: 'text', role_target: 'home_base',
      prompt: 'WineMaster will likely use these same persuasion tactics on you. Which one are you personally most vulnerable to in this negotiation, and what will you do in the room to keep it from moving you off your numbers?',
      placeholder: '', order: 22, hidden: false, deletable: true,
    },
  ],

  // BU-phase: content fields not used by backend factories; populated in BU slices.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
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
