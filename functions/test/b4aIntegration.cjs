'use strict'

// B4a integration tests: submitLeadOutcome + submitConfirmation
// Run with: node test/b4aIntegration.cjs

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8082'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9002'

const admin = require('firebase-admin')
admin.initializeApp({
  projectId: 'winemaster-mygames-live',
  databaseURL: 'http://localhost:9002?ns=winemaster-mygames-live',
})
const db = admin.firestore()

const BASE = 'http://localhost:5005/winemaster-mygames-live/us-central1'

// Participants: w1 is lead, w2/h1/h2 are non-leads.
const W1 = 'w1', W2 = 'w2', H1 = 'h1', H2 = 'h2'
const NON_LEADS = [W2, H1, H2]
const VALID_OUTCOME = { shares: 50000, vesting: 'Pro Rata', board_seat: true, liability: 25000 }

let passed = 0, failed = 0

function ok(label, result) {
  if (result) { console.log(`  [PASS] ${label}`); passed++ }
  else        { console.log(`  [FAIL] ${label}`); failed++ }
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

function testId(name) {
  return `b4a_${name}_${Date.now()}`
}

async function seed(gameId, groupId = 'grp1') {
  return post('/seedGroupForTest', {
    game_instance_id: gameId,
    group_id: groupId,
    lead_id: W1,
    winemaster_participants: [W1, W2],
    home_base_participants: [H1, H2],
  })
}

async function readGroup(gameId, groupId = 'grp1') {
  const snap = await db.collection('game_instances').doc(gameId).collection('groups').doc(groupId).get()
  return snap.data()
}

function test(name, id, fn) {
  return fn().catch(err => {
    console.log(`  [FAIL] ${name}: threw ${err.message}`)
    failed++
  })
}

// ─── 1. Deal submit ──────────────────────────────────────────────────────────
async function testDealSubmit() {
  console.log('\n1. Deal submit')
  const gameId = testId('deal_submit')
  await seed(gameId)

  const r = await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })
  ok('returns { ok: true }', r.status === 200 && r.body.ok === true)

  const g = await readGroup(gameId)
  ok('status → reporting', g.status === 'reporting')
  ok('lead_outcome = struct', JSON.stringify(g.lead_outcome) === JSON.stringify(VALID_OUTCOME))
  ok('lead_reported_at set', g.lead_reported_at != null)
  ok('3 non-leads in confirmations', Object.keys(g.confirmations).length === 3)
  ok('all confirmations pending', Object.values(g.confirmations).every(v => v === 'pending'))
  ok('confirmations keyed by correct pids',
    NON_LEADS.every(pid => pid in g.confirmations) && !(W1 in g.confirmations))
}

// ─── 2. Full approval ────────────────────────────────────────────────────────
async function testFullApproval() {
  console.log('\n2. Full approval (3 non-leads confirm)')
  const gameId = testId('full_approval')
  await seed(gameId)
  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })

  // First two confirmations return 'waiting'
  const r1 = await post('/submitConfirmation', {
    _test: { participant_id: W2, game_instance_id: gameId }, confirmed: true,
  })
  ok('W2 confirms → waiting', r1.status === 200 && r1.body.outcome === 'waiting')

  const r2 = await post('/submitConfirmation', {
    _test: { participant_id: H1, game_instance_id: gameId }, confirmed: true,
  })
  ok('H1 confirms → waiting', r2.status === 200 && r2.body.outcome === 'waiting')

  // Third confirmation locks the outcome
  const r3 = await post('/submitConfirmation', {
    _test: { participant_id: H2, game_instance_id: gameId }, confirmed: true,
  })
  ok('H2 confirms → locked', r3.status === 200 && r3.body.outcome === 'locked')

  const g = await readGroup(gameId)
  ok('status → completed', g.status === 'completed')
  ok('outcome = submitted struct', JSON.stringify(g.outcome) === JSON.stringify(VALID_OUTCOME))
  ok('agreement_reached: true', g.agreement_reached === true)
  ok('completed_at set', g.completed_at != null)
  ok('all confirmations = confirmed',
    Object.values(g.confirmations).every(v => v === 'confirmed'))
}

// ─── 3. Rejection → reset ────────────────────────────────────────────────────
async function testRejectionReset() {
  console.log('\n3. Rejection → reset (1 non-lead rejects)')
  const gameId = testId('rejection_reset')
  await seed(gameId)
  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })

  const r = await post('/submitConfirmation', {
    _test: { participant_id: W2, game_instance_id: gameId }, confirmed: false,
  })
  ok('returns { ok: true, outcome: "rejected" }', r.status === 200 && r.body.outcome === 'rejected')

  const g = await readGroup(gameId)
  ok('status still reporting', g.status === 'reporting')
  ok('reset_count: 1', g.reset_count === 1)
  ok('lead_outcome cleared to null', g.lead_outcome === null)
  ok('lead_reported_at cleared', g.lead_reported_at === null)
  ok('all confirmations back to pending',
    Object.values(g.confirmations).every(v => v === 'pending'))
}

// ─── 4. Deadlock (5 reset rounds) ───────────────────────────────────────────
async function testDeadlock() {
  console.log('\n4. Deadlock (5 reset rounds via W2 reject)')
  const gameId = testId('deadlock')
  await seed(gameId)

  for (let round = 1; round <= 4; round++) {
    await post('/submitLeadOutcome', {
      _test: { participant_id: W1, game_instance_id: gameId },
      outcome: VALID_OUTCOME,
    })
    const r = await post('/submitConfirmation', {
      _test: { participant_id: W2, game_instance_id: gameId }, confirmed: false,
    })
    ok(`round ${round}: outcome = rejected`, r.body.outcome === 'rejected')
  }

  // 5th round: rejection → deadlocked
  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })
  const r5 = await post('/submitConfirmation', {
    _test: { participant_id: W2, game_instance_id: gameId }, confirmed: false,
  })
  ok('round 5: outcome = deadlocked', r5.status === 200 && r5.body.outcome === 'deadlocked')

  const g = await readGroup(gameId)
  ok('status → deadlocked', g.status === 'deadlocked')
  ok('reset_count = 5', g.reset_count === 5)
}

// ─── 5. No-deal ──────────────────────────────────────────────────────────────
async function testNoDeal() {
  console.log('\n5. No-deal (outcome: null, all approve)')
  const gameId = testId('no_deal')
  await seed(gameId)

  const sub = await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: null,
  })
  ok('no-deal submit returns ok', sub.status === 200 && sub.body.ok === true)

  const gMid = await readGroup(gameId)
  ok('lead_outcome is null in reporting state', gMid.lead_outcome === null && gMid.status === 'reporting')
  ok('lead_reported_at set (distinguishes null-outcome from reset)', gMid.lead_reported_at != null)

  for (const pid of NON_LEADS) {
    await post('/submitConfirmation', {
      _test: { participant_id: pid, game_instance_id: gameId }, confirmed: true,
    })
  }

  const g = await readGroup(gameId)
  ok('status → completed', g.status === 'completed')
  ok('outcome: null', g.outcome === null)
  ok('agreement_reached: false', g.agreement_reached === false)
}

// ─── 6. Validation error ─────────────────────────────────────────────────────
async function testValidationError() {
  console.log('\n6. Validation error (shares out of range, missing field)')
  const gameId = testId('validation')
  await seed(gameId)

  const r1 = await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: { shares: 999999, vesting: 'Pro Rata', board_seat: true, liability: 5000 },
  })
  ok('400 on shares > max', r1.status === 400)
  ok('details contains shares error', Array.isArray(r1.body.details) && r1.body.details.some(e => e.includes('shares')))

  const r2 = await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: { shares: 5000, vesting: 'Invalid Option', board_seat: true, liability: 5000 },
  })
  ok('400 on invalid vesting enum', r2.status === 400 && Array.isArray(r2.body.details))

  const r3 = await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: { shares: 5000, vesting: 'Immediate', board_seat: true },
  })
  ok('400 on missing liability field', r3.status === 400 && r3.body.details.some(e => e.includes('liability')))

  const gAfter = await readGroup(gameId)
  ok('group doc unchanged (status: matched)', gAfter.status === 'matched')
}

// ─── 7. Idempotency guard ────────────────────────────────────────────────────
async function testIdempotency() {
  console.log('\n7. Idempotency — non-lead confirms twice')
  const gameId = testId('idempotency')
  await seed(gameId)
  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })

  const r1 = await post('/submitConfirmation', {
    _test: { participant_id: W2, game_instance_id: gameId }, confirmed: true,
  })
  ok('first confirm succeeds', r1.status === 200)

  const r2 = await post('/submitConfirmation', {
    _test: { participant_id: W2, game_instance_id: gameId }, confirmed: true,
  })
  ok('second confirm → 400 Already responded', r2.status === 400 && r2.body.error.includes('Already responded'))

  const g = await readGroup(gameId)
  ok('W2 still confirmed (not double-counted)', g.confirmations[W2] === 'confirmed')
  ok('status still reporting (not prematurely committed)', g.status === 'reporting')
}

// ─── 8. Race safety (concurrent confirmations) ───────────────────────────────
async function testRaceSafety() {
  console.log('\n8. Race safety (W2 + H1 confirm simultaneously via Promise.all)')
  const gameId = testId('race')
  await seed(gameId)
  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })

  // Fire two confirmations in parallel — transaction ensures both are recorded.
  const [r1, r2] = await Promise.all([
    post('/submitConfirmation', { _test: { participant_id: W2, game_instance_id: gameId }, confirmed: true }),
    post('/submitConfirmation', { _test: { participant_id: H1, game_instance_id: gameId }, confirmed: true }),
  ])
  ok('W2 confirm ok', r1.status === 200)
  ok('H1 confirm ok', r2.status === 200)

  const g = await readGroup(gameId)
  ok('both W2 and H1 recorded as confirmed',
    g.confirmations[W2] === 'confirmed' && g.confirmations[H1] === 'confirmed')
  ok('H2 still pending (not committed yet)', g.confirmations[H2] === 'pending')
  ok('status still reporting', g.status === 'reporting')
  console.log('  [NOTE] Transaction guarantees serial read-apply-write: no lost confirmation possible')
}

// ─── 9. Lead guard & status guard edge cases ─────────────────────────────────
async function testGuards() {
  console.log('\n9. Auth guards — non-lead tries submitLeadOutcome; lead tries submitConfirmation')
  const gameId = testId('guards')
  await seed(gameId)

  const r1 = await post('/submitLeadOutcome', {
    _test: { participant_id: W2, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })
  ok('non-lead → 403', r1.status === 403)

  await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })
  const r2 = await post('/submitConfirmation', {
    _test: { participant_id: W1, game_instance_id: gameId }, confirmed: true,
  })
  ok('lead tries submitConfirmation → 403', r2.status === 403)

  const r3 = await post('/submitLeadOutcome', {
    _test: { participant_id: W1, game_instance_id: gameId },
    outcome: VALID_OUTCOME,
  })
  ok('already submitted → 400 Already submitted this round', r3.status === 400 && r3.body.error.includes('Already submitted'))
}

async function main() {
  console.log('\n══ Winemaster B4a integration tests ══')
  await testDealSubmit()
  await testFullApproval()
  await testRejectionReset()
  await testDeadlock()
  await testNoDeal()
  await testValidationError()
  await testIdempotency()
  await testRaceSafety()
  await testGuards()

  console.log(`\n══ Summary: ${passed} passed, ${failed} failed ══\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('Unexpected error:', err); process.exit(1) })
