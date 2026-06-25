'use strict'

// P2 integration tests: startNegotiation + submitInstructorOutcome
// Run with: node test/p2Integration.cjs
// Requires the winemaster emulator to be running (firebase emulators:start).

process.env.FIRESTORE_EMULATOR_HOST      = 'localhost:8082'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9002'

const admin = require('firebase-admin')
admin.initializeApp({
  projectId:   'winemaster-mygames-live',
  databaseURL: 'https://winemaster-mygames-live-default-rtdb.firebaseio.com',
})
const db = admin.firestore()

const BASE = 'http://localhost:5005/winemaster-mygames-live/us-central1'

const W1 = 'p2_w1', W2 = 'p2_w2', H1 = 'p2_h1', H2 = 'p2_h2'
const VALID_OUTCOME = { shares: 75000, vesting: 'Pro Rata', board_seat: false, liability: 100000 }

let passed = 0, failed = 0

function ok(label, result) {
  if (result) { console.log(`  [PASS] ${label}`); passed++ }
  else        { console.log(`  [FAIL] ${label}`); failed++ }
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ data: body }),
  })
  const json = await r.json()
  let unwrapped
  if (json.result !== undefined) {
    unwrapped = json.result
  } else if (json.error !== undefined) {
    const errMsg = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error))
    unwrapped = { ok: false, error: errMsg }
  } else {
    unwrapped = json  // onRequest (seedFunctions) return flat JSON
  }
  return { status: r.status, body: unwrapped }
}

function testId(name) { return `p2_${name}_${Date.now()}` }

async function seedGroup(gameId, groupId = 'p2grp1') {
  return post('/seedGroupForTest', {
    game_instance_id:       gameId,
    group_id:               groupId,
    lead_id:                W1,
    winemaster_participants: [W1, W2],
    home_base_participants:  [H1, H2],
  })
}

async function readGroup(gameId, groupId = 'p2grp1') {
  const s = await db.collection('game_instances').doc(gameId).collection('groups').doc(groupId).get()
  return s.data()
}

// ─── 1. startNegotiation: matched → negotiating ──────────────────────────────
async function testStartNegotiation() {
  console.log('\n1. startNegotiation: matched → negotiating')
  const gameId = testId('start')
  await seedGroup(gameId)

  // Any member can call (W2, a non-lead)
  const r = await post('/startNegotiation', {
    _test: { participant_id: W2, game_instance_id: gameId },
  })
  ok('returns { ok: true }', r.status === 200 && r.body.ok === true)

  const g = await readGroup(gameId)
  ok('status → negotiating', g.status === 'negotiating')
  ok('negotiation_started_at set', g.negotiation_started_at != null)
}

// ─── 2. startNegotiation: idempotent (already negotiating) ───────────────────
async function testStartNegotiationIdempotent() {
  console.log('\n2. startNegotiation: idempotent on already-negotiating group')
  const gameId = testId('start_idem')
  await seedGroup(gameId)
  await post('/startNegotiation', { _test: { participant_id: W1, game_instance_id: gameId } })

  const r = await post('/startNegotiation', {
    _test: { participant_id: W2, game_instance_id: gameId },
  })
  ok('second call → still ok', r.status === 200 && r.body.ok === true)

  const g = await readGroup(gameId)
  ok('status remains negotiating', g.status === 'negotiating')
}

// ─── 3. startNegotiation: wrong status guard ─────────────────────────────────
async function testStartNegotiationWrongStatus() {
  console.log('\n3. startNegotiation: rejects on completed group')
  const gameId = testId('start_err')
  await seedGroup(gameId)

  // Advance to completed via instructor override, then try startNegotiation
  await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId }, group_id: 'p2grp1', outcome: VALID_OUTCOME,
  })

  const r = await post('/startNegotiation', {
    _test: { participant_id: W1, game_instance_id: gameId },
  })
  ok('400 on completed group', r.status === 400)
  ok('error mentions group status', r.status === 400 && typeof r.body.error === 'string' && r.body.error.length > 0)
}

// ─── 4. submitInstructorOutcome: deal override ───────────────────────────────
async function testInstructorOutcomeDeal() {
  console.log('\n4. submitInstructorOutcome: deal override on deadlocked group')
  const gameId = testId('inst_deal')
  await seedGroup(gameId)

  // Drive to deadlocked via 5 rejection rounds
  for (let round = 1; round <= 5; round++) {
    await post('/submitLeadOutcome', {
      _test: { participant_id: W1, game_instance_id: gameId }, outcome: VALID_OUTCOME,
    })
    await post('/submitConfirmation', {
      _test: { participant_id: W2, game_instance_id: gameId }, confirmed: false,
    })
  }

  const gBefore = await readGroup(gameId)
  ok('setup: group is deadlocked', gBefore.status === 'deadlocked')

  const r = await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId },
    group_id: 'p2grp1',
    outcome: VALID_OUTCOME,
  })
  ok('returns { ok: true }', r.status === 200 && r.body.ok === true)

  const g = await readGroup(gameId)
  ok('status → completed', g.status === 'completed')
  ok('outcome matches', JSON.stringify(g.outcome) === JSON.stringify(VALID_OUTCOME))
  ok('agreement_reached: true', g.agreement_reached === true)
  ok('instructor_override: true', g.instructor_override === true)
  ok('completed_at set', g.completed_at != null)
}

// ─── 5. submitInstructorOutcome: no-deal override ────────────────────────────
async function testInstructorOutcomeNoDeal() {
  console.log('\n5. submitInstructorOutcome: no-deal override (null outcome)')
  const gameId = testId('inst_nodeal')
  await seedGroup(gameId)

  const r = await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId },
    group_id: 'p2grp1',
    outcome: null,
  })
  ok('returns ok', r.status === 200 && r.body.ok === true)

  const g = await readGroup(gameId)
  ok('status → completed', g.status === 'completed')
  ok('outcome: null', g.outcome === null)
  ok('agreement_reached: false', g.agreement_reached === false)
  ok('instructor_override: true', g.instructor_override === true)
}

// ─── 6. submitInstructorOutcome: no_deal flag (Winemaster dashboard shape) ───
async function testInstructorOutcomeNoDealFlag() {
  console.log('\n6. submitInstructorOutcome: { no_deal: true } flag from dashboard')
  const gameId = testId('inst_nodealflag')
  await seedGroup(gameId)

  const r = await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId },
    group_id: 'p2grp1',
    outcome: { no_deal: true },
  })
  ok('returns ok', r.status === 200 && r.body.ok === true)

  const g = await readGroup(gameId)
  ok('outcome null (no_deal flag treated as null)', g.outcome === null)
  ok('agreement_reached: false', g.agreement_reached === false)
}

// ─── 7. submitInstructorOutcome: schema validation ───────────────────────────
async function testInstructorOutcomeValidation() {
  console.log('\n7. submitInstructorOutcome: schema validation')
  const gameId = testId('inst_validation')
  await seedGroup(gameId)

  const r1 = await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId },
    group_id: 'p2grp1',
    outcome: { shares: 9999999, vesting: 'Pro Rata', board_seat: false, liability: 0 },
  })
  ok('400 on shares > max', r1.status === 400)

  const r2 = await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId },
    group_id: 'p2grp1',
    outcome: { shares: 50000, vesting: 'Invalid Vesting', board_seat: false, liability: 0 },
  })
  ok('400 on invalid enum', r2.status === 400)

  const gAfter = await readGroup(gameId)
  ok('group still matched (not modified)', gAfter.status === 'matched')
}

// ─── 8. submitInstructorOutcome: already-completed guard ────────────────────
async function testInstructorOutcomeAlreadyCompleted() {
  console.log('\n8. submitInstructorOutcome: rejects on already-completed group')
  const gameId = testId('inst_already')
  await seedGroup(gameId)

  await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId }, group_id: 'p2grp1', outcome: VALID_OUTCOME,
  })

  const r = await post('/submitInstructorOutcome', {
    _dev: { game_instance_id: gameId }, group_id: 'p2grp1', outcome: VALID_OUTCOME,
  })
  ok('400 on double-lock', r.status === 400)
  ok('error mentions already locked', r.body.error.toLowerCase().includes('already') || r.body.error.toLowerCase().includes('complete'))
}

// ─── 9. Full P2 flow: match → negotiate → lead+confirms → completed ──────────
async function testFullP2Flow() {
  console.log('\n9. Full P2 flow: startNegotiation → submitLeadOutcome → all confirm → completed')
  const gameId = testId('full_p2')
  await seedGroup(gameId)

  // Step 1: Start negotiation
  await post('/startNegotiation', { _test: { participant_id: W1, game_instance_id: gameId } })
  const g1 = await readGroup(gameId)
  ok('step 1: negotiating', g1.status === 'negotiating')

  // Step 2: Lead reports outcome
  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId }, outcome: VALID_OUTCOME,
  })
  const g2 = await readGroup(gameId)
  ok('step 2: reporting', g2.status === 'reporting')

  // Step 3: All non-leads confirm
  for (const pid of [W2, H1, H2]) {
    await post('/submitConfirmation', {
      _test: { participant_id: pid, game_instance_id: gameId }, confirmed: true,
    })
  }

  const gFinal = await readGroup(gameId)
  ok('step 3: completed', gFinal.status === 'completed')
  ok('outcome locked', JSON.stringify(gFinal.outcome) === JSON.stringify(VALID_OUTCOME))
  ok('agreement_reached: true', gFinal.agreement_reached === true)
  ok('no instructor_override', !gFinal.instructor_override)
}

// ─── 10. getDebriefQuestions returns empty for Winemaster default ─────────────
async function testGetDebriefQuestions() {
  console.log('\n10. getDebriefQuestions: returns empty array (no debrief defaults in Winemaster)')
  const gameId = testId('debrief_qs')
  await seedGroup(gameId)

  const r = await post('/getDebriefQuestions', {
    _test: { participant_id: W1, game_instance_id: gameId },
  })
  ok('returns ok', r.status === 200 && r.body.ok === true)
  ok('questions is array', Array.isArray(r.body.questions))
  ok('no debrief questions by default', r.body.questions.length === 0)
}

async function main() {
  console.log('\n══ Winemaster P2 integration tests ══')
  await testStartNegotiation()
  await testStartNegotiationIdempotent()
  await testStartNegotiationWrongStatus()
  await testInstructorOutcomeDeal()
  await testInstructorOutcomeNoDeal()
  await testInstructorOutcomeNoDealFlag()
  await testInstructorOutcomeValidation()
  await testInstructorOutcomeAlreadyCompleted()
  await testFullP2Flow()
  await testGetDebriefQuestions()

  console.log(`\n══ Summary: ${passed} passed, ${failed} failed ══\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('Unexpected error:', err); process.exit(1) })
