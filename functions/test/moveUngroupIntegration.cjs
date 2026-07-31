'use strict'

// ═══════════════════════════════════════════════════════════════════════════════
// Move / Ungroup INTEGRATION — the real `moveSeat` callable against the emulator.
// End-to-end walk-through (spec v3 Phase 1 / §"VERIFY END-TO-END"):
//   match a class → move a student between not-started groups → ungroup → confirm the
//   freed seat + No-Group pool → new-group → start one group and confirm it LOCKS against
//   moves while a not-started sibling still moves.
//
// Assertions read state back from FIRESTORE (a different source than the callable's own
// return), and each lock rule carries a NEGATIVE CONTROL that must be REJECTED, plus a
// POSITIVE CONTROL that must succeed — so a green means the lock discriminates.
//
// Run with the winemaster emulator up:  node test/moveUngroupIntegration.cjs
// ═══════════════════════════════════════════════════════════════════════════════

process.env.FIRESTORE_EMULATOR_HOST         = 'localhost:8082'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9002'

const admin = require('firebase-admin')
admin.initializeApp({
  projectId:   'winemaster-mygames-live',
  databaseURL: 'https://winemaster-mygames-live-default-rtdb.firebaseio.com',
})
const db = admin.firestore()

const BASE = 'http://localhost:5005/winemaster-mygames-live/us-central1'

let passed = 0, failed = 0
function ok(label, cond, extra) {
  if (cond) { console.log(`  [PASS] ${label}`); passed++ }
  else      { console.log(`  [FAIL] ${label}${extra !== undefined ? ` — ${extra}` : ''}`); failed++ }
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: body }),
  })
  const json = await r.json()
  let unwrapped
  if (json.result !== undefined) unwrapped = json.result
  else if (json.error !== undefined) {
    const msg = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error))
    unwrapped = { ok: false, error: msg }
  } else unwrapped = json
  return { status: r.status, body: unwrapped }
}

const ROLE_ARRAYS = ['winemaster_participants', 'home_base_participants']
const membersOf = (g) => ROLE_ARRAYS.flatMap(k => g[k] || [])

async function readGroups(gameId) {
  const snap = await db.collection('game_instances').doc(gameId).collection('groups').get()
  return snap.docs.map(d => d.data()).sort((a, b) => a.group_id.localeCompare(b.group_id))
}
async function readParticipant(gameId, pid) {
  const s = await db.collection('game_instances').doc(gameId).collection('participants').doc(pid).get()
  return s.exists ? s.data() : null
}
async function readNoGroupPool(gameId) {
  const snap = await db.collection('game_instances').doc(gameId).collection('participants').get()
  return snap.docs.map(d => d.data()).filter(p => p.group_id == null).map(p => p.participant_id)
}

// Which groups (by id) currently list this pid in ANY role array. Derived by scanning all
// groups — the "exactly one" source of truth, independent of any participant.group_id field.
function groupsContaining(groups, pid) {
  return groups.filter(g => membersOf(g).includes(pid)).map(g => g.group_id)
}

async function moveSeat(gameId, pid, target) {
  return post('/moveSeat', { _dev: { game_instance_id: gameId }, participant_id: pid, target_group_id: target })
}

async function main() {
  const gameId = `mv_${Date.now()}`
  console.log(`\n══ Winemaster move/ungroup integration (${gameId}) ══`)

  // ── Setup: match a class of 4 winemasters + 4 home_base → two 2v2 groups ──────
  const parts = []
  for (let i = 1; i <= 4; i++) parts.push({ id: `mvw${i}`, role: 'winemaster' })
  for (let i = 1; i <= 4; i++) parts.push({ id: `mvh${i}`, role: 'home_base' })
  await post('/seedMatchTest', { game_instance_id: gameId, participants: parts })
  const match = await post('/triggerMatching', { _dev: { game_instance_id: gameId } })
  ok('setup: matching ok', match.body.ok === true, match.body.error)

  let groups = await readGroups(gameId)
  ok('setup: exactly 2 groups formed', groups.length === 2, groups.length)
  if (groups.length !== 2) { done(); return }
  let [A, B] = groups
  ok('setup: both groups matched (not started)', A.status === 'matched' && B.status === 'matched')

  // Self-test of the "exactly one" checker — prove it is not constant-1 (07-29 discipline).
  const fakeDouble = [{ group_id: 'X', winemaster_participants: ['dup'], home_base_participants: [] },
                      { group_id: 'Y', winemaster_participants: ['dup'], home_base_participants: [] }]
  ok('NEGATIVE CONTROL: groupsContaining detects a two-group member', groupsContaining(fakeDouble, 'dup').length === 2)

  // ── T1: MOVE a winemaster from A → B (both not started) ───────────────────────
  console.log('\n1. Move a student between not-started groups')
  const sW = A.winemaster_participants[0]
  const aWinemastersBefore = A.winemaster_participants.length
  const bWinemastersBefore = B.winemaster_participants.length
  const mv = await moveSeat(gameId, sW, B.group_id)
  ok('move returns ok', mv.body.ok === true, mv.body.error)

  groups = await readGroups(gameId)
  A = groups.find(g => g.group_id === A.group_id)
  B = groups.find(g => g.group_id === B.group_id)
  const pSW = await readParticipant(gameId, sW)
  ok('participant.group_id now B', pSW.group_id === B.group_id)
  ok('EXACTLY ONE group contains the student', groupsContaining(groups, sW).length === 1, groupsContaining(groups, sW).join(','))
  ok('source A no longer lists the student', !A.winemaster_participants.includes(sW))
  ok('destination B now lists the student', B.winemaster_participants.includes(sW))
  ok('role PRESERVED: in B winemaster array, NOT home_base', B.winemaster_participants.includes(sW) && !B.home_base_participants.includes(sW))
  ok('participant doc role unchanged (winemaster)', pSW.role === 'winemaster')
  ok('A winemaster count fell by 1', A.winemaster_participants.length === aWinemastersBefore - 1, A.winemaster_participants.length)
  ok('B winemaster count rose by 1', B.winemaster_participants.length === bWinemastersBefore + 1, B.winemaster_participants.length)

  // ── T2: UNGROUP a home_base from A → the No-Group pool ────────────────────────
  console.log('\n2. Ungroup a student (group stands, seat frees)')
  const uH = A.home_base_participants[0]
  const aHomeBefore = A.home_base_participants.length
  const un = await moveSeat(gameId, uH, '') // '' = ungroup
  ok('ungroup returns ok', un.body.ok === true, un.body.error)

  groups = await readGroups(gameId)
  A = groups.find(g => g.group_id === A.group_id)
  const pUH = await readParticipant(gameId, uH)
  ok('ungrouped participant.group_id is null', pUH.group_id === null)
  ok('participant is in NO group array', groupsContaining(groups, uH).length === 0)
  ok('group A STILL EXISTS (stands)', A != null)
  ok('A home_base seat freed (count fell by 1)', A.home_base_participants.length === aHomeBefore - 1, A.home_base_participants.length)
  const pool = await readNoGroupPool(gameId)
  ok('ungrouped student appears in the No-Group pool', pool.includes(uH), pool.join(','))

  // ── T3: place the ungrouped student into a NEW group ──────────────────────────
  console.log('\n3. Place the ungrouped student into a new group')
  const knownIds = new Set(groups.map(g => g.group_id))
  const ng = await moveSeat(gameId, uH, 'new')
  ok('new-group placement returns ok', ng.body.ok === true, ng.body.error)
  groups = await readGroups(gameId)
  const newGroup = groups.find(g => !knownIds.has(g.group_id))
  ok('a brand-new group was created', newGroup != null)
  ok('the student is in exactly one group again', groupsContaining(groups, uH).length === 1)
  const pUH2 = await readParticipant(gameId, uH)
  ok('participant.group_id points at the new group', newGroup != null && pUH2.group_id === newGroup.group_id)

  // ── T4: start a group → it LOCKS; a not-started sibling still moves ───────────
  console.log('\n4. Start group B → it locks (in AND out); a not-started sibling still moves')
  const bMember = B.winemaster_participants[0]
  const start = await post('/startNegotiation', { _test: { participant_id: bMember, game_instance_id: gameId } })
  ok('setup: startNegotiation ok', start.body.ok === true, start.body.error)
  B = (await readGroups(gameId)).find(g => g.group_id === B.group_id)
  ok('setup: B is now negotiating (started)', B.status === 'negotiating' && B.negotiation_started_at != null)

  // NEGATIVE CONTROL — move OUT of a started group must be rejected.
  const outMember = B.home_base_participants[0]
  const outMove = await moveSeat(gameId, outMember, A.group_id)
  ok('NEGATIVE CONTROL: move OUT of started B is REJECTED', outMove.body.ok !== true, `status ${outMove.status}`)
  const pOut = await readParticipant(gameId, outMember)
  ok('  …and the student did NOT move (still in B)', pOut.group_id === B.group_id)

  // NEGATIVE CONTROL — move INTO a started group must be rejected.
  const inMember = A.winemaster_participants[0]
  const inMove = await moveSeat(gameId, inMember, B.group_id)
  ok('NEGATIVE CONTROL: move INTO started B is REJECTED', inMove.body.ok !== true, `status ${inMove.status}`)
  const pIn = await readParticipant(gameId, inMember)
  ok('  …and the student did NOT move (still in A)', pIn.group_id === A.group_id)

  // POSITIVE CONTROL — a NOT-STARTED sibling (A) still moves while B is locked. Per-group,
  // never instance-wide. Move an A member into the new group (also not started).
  const siblingMember = A.winemaster_participants[0]
  const sib = await moveSeat(gameId, siblingMember, newGroup.group_id)
  ok('POSITIVE CONTROL: not-started sibling A still moves while B is locked', sib.body.ok === true, sib.body.error)
  const pSib = await readParticipant(gameId, siblingMember)
  ok('  …the sibling move actually took effect', pSib.group_id === newGroup.group_id)

  done()
}

function done() {
  console.log(`\n══ Summary: ${passed} passed, ${failed} failed ══`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(err => { console.error('FATAL', err); process.exit(1) })
