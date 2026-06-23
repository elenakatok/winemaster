'use strict'

// B5 integration tests: finalizeInstance
// Requires emulators running: firebase emulators:start
// Run with: node test/b5Integration.cjs

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8082'

const admin = require('firebase-admin')
admin.initializeApp({ projectId: 'winemaster-mygames-live' })
const db = admin.firestore()

const BASE = 'http://localhost:5005/winemaster-mygames-live/us-central1'

let passed = 0, failed = 0

function ok(label, result, detail = '') {
  if (result) { console.log(`  [PASS] ${label}`); passed++ }
  else        { console.log(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`); failed++ }
}

function approxEq(a, b, tol = 0.001) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

function uid() { return `b5_${Date.now()}_${Math.floor(Math.random() * 9999)}` }

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function clearInstance(gameId) {
  const ref = db.collection('game_instances').doc(gameId)
  const [ps, gs] = await Promise.all([
    ref.collection('participants').get(),
    ref.collection('groups').get(),
  ])
  const batch = db.batch()
  for (const d of [...ps.docs, ...gs.docs]) batch.delete(d.ref)
  if (ps.size + gs.size > 0) await batch.commit()
}

async function seedCompletedGroup(gameId, groupId, wmPids, hbPids, leadId, outcome) {
  const ref = db.collection('game_instances').doc(gameId)
  const batch = db.batch()
  const agreementReached = outcome !== null
  batch.set(ref.collection('groups').doc(groupId), {
    group_id:              groupId,
    game_instance_id:      gameId,
    winemaster_participants: wmPids,
    home_base_participants:  hbPids,
    lead_participant_id:   leadId,
    outcome,
    agreement_reached:     agreementReached,
    status:                'completed',
    completed_at:          admin.firestore.FieldValue.serverTimestamp(),
  })
  for (const pid of wmPids) {
    batch.set(ref.collection('participants').doc(pid), {
      participant_id:   pid,
      game_instance_id: gameId,
      role:             'winemaster',
      group_id:         groupId,
      is_lead:          pid === leadId,
    })
  }
  for (const pid of hbPids) {
    batch.set(ref.collection('participants').doc(pid), {
      participant_id:   pid,
      game_instance_id: gameId,
      role:             'home_base',
      group_id:         groupId,
      is_lead:          false,
    })
  }
  await batch.commit()
}

async function seedNoShow(gameId, pid, role) {
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).set({
      participant_id:   pid,
      game_instance_id: gameId,
      role,
      // group_id intentionally absent → no-show classification
    })
}

async function readParticipant(gameId, pid) {
  const snap = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).get()
  return snap.data()
}

// ── Test: normal finalization ─────────────────────────────────────────────────

async function testFinalizeOk() {
  console.log('\n[T1] finalizeInstance: deal + walk-away + no-show')

  const gameId = uid()
  await clearInstance(gameId)

  // Deal group (Case 1 outcome): W raw=2_375_000, H raw=2_675_000.
  const DEAL_OUTCOME = { shares: 50000, vesting: 'Pro Rata', board_seat: true, liability: 500000 }
  await seedCompletedGroup(gameId, 'grpA', ['w1','w2'], ['h1','h2'], 'w1', DEAL_OUTCOME)

  // Walk-away group: outcome=null. W raw=0 (PROVISIONAL), H raw=1_000_000 (WALKAWAY_HB_PLACEHOLDER).
  await seedCompletedGroup(gameId, 'grpB', ['w3','w4'], ['h3','h4'], 'w3', null)

  // No-shows: no group_id stamped.
  await seedNoShow(gameId, 'w5', 'winemaster')
  await seedNoShow(gameId, 'h5', 'home_base')

  const r = await post('/finalizeInstance', { _dev: { game_instance_id: gameId } })
  ok('HTTP 200', r.status === 200, `got ${r.status}`)
  ok('ok:true', r.body.ok === true)
  ok('scored:10', r.body.scored === 10, `got ${r.body.scored}`)

  // Winemaster pool (value-sense): deal [2375000,2375000] vs walk-away [0,0].
  // With n=4 symmetric pairs, z = ±√3/2 ≈ ±0.86603.
  for (const pid of ['w1','w2']) {
    const p = await readParticipant(gameId, pid)
    ok(`${pid} raw=2_375_000`, p.raw_score === 2_375_000, p.raw_score)
    ok(`${pid} normalized≈+0.866`, approxEq(p.normalized_score, 0.86603), p.normalized_score)
    ok(`${pid} finalized_at set`, p.finalized_at != null)
  }
  for (const pid of ['w3','w4']) {
    const p = await readParticipant(gameId, pid)
    ok(`${pid} raw=0 (PROVISIONAL)`, p.raw_score === 0, p.raw_score)
    ok(`${pid} normalized≈−0.866`, approxEq(p.normalized_score, -0.86603), p.normalized_score)
  }
  const w5 = await readParticipant(gameId, 'w5')
  ok('w5 (no-show) raw=null',        w5.raw_score === null)
  ok('w5 (no-show) normalized=−2',   w5.normalized_score === -2)
  ok('w5 finalized_at set',          w5.finalized_at != null)

  // Home base pool (cost-sense): deal raw=2_675_000 → signed=−2_675_000;
  // walk-away raw=1_000_000 (PROVISIONAL) → signed=−1_000_000. Same ±√3/2 structure.
  // deal HB: higher cost → lower z (worse). walk-away HB: lower placeholder → higher z (visibly wrong).
  for (const pid of ['h1','h2']) {
    const p = await readParticipant(gameId, pid)
    ok(`${pid} raw=2_675_000 (unsigned)`, p.raw_score === 2_675_000, p.raw_score)
    ok(`${pid} normalized≈−0.866`, approxEq(p.normalized_score, -0.86603), p.normalized_score)
    ok(`${pid} finalized_at set`, p.finalized_at != null)
  }
  for (const pid of ['h3','h4']) {
    const p = await readParticipant(gameId, pid)
    ok(`${pid} raw=1_000_000 (PROVISIONAL sentinel)`, p.raw_score === 1_000_000, p.raw_score)
    // Visibly wrong: walk-away HB scores BETTER (+0.866) than deal HB (−0.866).
    ok(`${pid} normalized≈+0.866 (PROVISIONAL — visibly wrong)`, approxEq(p.normalized_score, 0.86603), p.normalized_score)
  }
  const h5 = await readParticipant(gameId, 'h5')
  ok('h5 (no-show) raw=null',        h5.raw_score === null)
  ok('h5 (no-show) normalized=−2',   h5.normalized_score === -2)
  ok('h5 finalized_at set',          h5.finalized_at != null)
}

// ── Test: guard fires on unresolved group ─────────────────────────────────────

async function testGuardFires() {
  console.log('\n[T2] guard: unresolved group → 400, nothing written')

  const gameId = uid()
  await clearInstance(gameId)

  // One completed group.
  await seedCompletedGroup(gameId, 'grpOk', ['wg1'], ['hg1'], 'wg1',
    { shares: 50000, vesting: 'Pro Rata', board_seat: false, liability: 0 })

  // One group still in 'reporting' status (not yet resolved).
  await db.collection('game_instances').doc(gameId)
    .collection('groups').doc('grpPending').set({
      group_id: 'grpPending', game_instance_id: gameId,
      status: 'reporting', outcome: null,
    })
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc('wg2').set({
      participant_id: 'wg2', game_instance_id: gameId,
      role: 'winemaster', group_id: 'grpPending',
    })

  const r = await post('/finalizeInstance', { _dev: { game_instance_id: gameId } })
  ok('HTTP 400', r.status === 400, `got ${r.status}`)
  ok('ok:false', r.body.ok === false)
  ok('error mentions group id', typeof r.body.error === 'string' && r.body.error.includes('grpPending'))

  // Participants must NOT have finalized_at written.
  const wg1 = await readParticipant(gameId, 'wg1')
  ok('wg1 not finalized', wg1 == null || wg1.finalized_at == null,
    `wg1.finalized_at = ${wg1?.finalized_at}`)
  const wg2 = await readParticipant(gameId, 'wg2')
  ok('wg2 not finalized', wg2 == null || wg2.finalized_at == null,
    `wg2.finalized_at = ${wg2?.finalized_at}`)
}

// ── Test: idempotency — re-finalize overwrites scores ────────────────────────

async function testIdempotent() {
  console.log('\n[T3] idempotency: re-call overwrites, same result')

  const gameId = uid()
  await clearInstance(gameId)
  const OUTCOME = { shares: 60000, vesting: 'Immediate', board_seat: false, liability: 200000 }
  await seedCompletedGroup(gameId, 'grpX', ['wX1','wX2'], ['hX1'], 'wX1', OUTCOME)

  const r1 = await post('/finalizeInstance', { _dev: { game_instance_id: gameId } })
  ok('first call ok', r1.status === 200 && r1.body.ok)

  const before = await readParticipant(gameId, 'wX1')
  const r2 = await post('/finalizeInstance', { _dev: { game_instance_id: gameId } })
  ok('second call ok', r2.status === 200 && r2.body.ok)

  const after = await readParticipant(gameId, 'wX1')
  ok('raw_score stable across re-finalize', before.raw_score === after.raw_score,
    `${before.raw_score} vs ${after.raw_score}`)
  ok('normalized_score stable', approxEq(before.normalized_score, after.normalized_score),
    `${before.normalized_score} vs ${after.normalized_score}`)
}

// ── Runner ────────────────────────────────────────────────────────────────────

;(async () => {
  try {
    await testFinalizeOk()
    await testGuardFires()
    await testIdempotent()
  } catch (err) {
    console.error('\nUnhandled error:', err)
    failed++
  }

  console.log(`\n── B5 Integration ── ${passed} passed, ${failed} failed ──`)
  process.exit(failed > 0 ? 1 : 0)
})()
