'use strict'

// B7a integration tests: getInstructorSession + getRoster
// Requires emulators running: firebase emulators:start --only functions,firestore,database,auth
// Run with: node test/b7aIntegration.cjs
//
// Tests:
//   T1: getInstructorSession _dev bypass → customToken with correct uid/claims
//   T2: getInstructorSession missing token (no _dev, no token) → 400
//   T3: getRoster _dev bypass, empty instance → ok, empty arrays
//   T4: getRoster _dev bypass, seeded instance → participants + groups match seed

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8082'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9002'

const admin = require('firebase-admin')
admin.initializeApp({ projectId: 'winemaster-mygames-live', databaseURL: 'http://localhost:9002/?ns=winemaster-mygames-live' })
const db   = admin.firestore()
const rtdb = admin.database()

const BASE = 'http://localhost:5005/winemaster-mygames-live/us-central1'

let passed = 0, failed = 0

function ok(label, cond, detail = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passed++ }
  else       { console.log(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`); failed++ }
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

function uid() { return `b7a_${Date.now()}_${Math.floor(Math.random() * 9999)}` }

async function clearInstance(gameId) {
  const ref = db.collection('game_instances').doc(gameId)
  const [ps, gs] = await Promise.all([
    ref.collection('participants').get(),
    ref.collection('groups').get(),
  ])
  const batch = db.batch()
  for (const d of [...ps.docs, ...gs.docs]) batch.delete(d.ref)
  if (ps.size + gs.size > 0) await batch.commit()
  await rtdb.ref(`attending/${gameId}`).remove()
  await rtdb.ref(`presence/${gameId}`).remove()
}

// ── T1: getInstructorSession _dev bypass ──────────────────────────────────────

async function t1() {
  console.log('\nT1: getInstructorSession _dev bypass')
  const gameId = uid()
  const { status, body } = await post('/getInstructorSession', { _dev: { game_instance_id: gameId } })

  ok('status 200',          status === 200,              `got ${status}`)
  ok('ok: true',            body.ok === true)
  ok('customToken present', typeof body.customToken === 'string' && body.customToken.length > 10)

  if (typeof body.customToken === 'string') {
    // Firebase custom tokens are JWTs; decode without signature verification to inspect claims.
    const [, payloadB64] = body.customToken.split('.')
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))

    ok('uid = instructor_<gameId>', payload.uid === `instructor_${gameId}`,
       `uid was: ${payload.uid}`)
    ok('claim role = instructor',   payload.claims?.role === 'instructor',
       `claims: ${JSON.stringify(payload.claims)}`)
    ok('claim game_instance_id',    payload.claims?.game_instance_id === gameId,
       `claims: ${JSON.stringify(payload.claims)}`)
  }
}

// ── T2: getInstructorSession — missing token in production path ───────────────

async function t2() {
  console.log('\nT2: getInstructorSession missing token (non-dev body)')
  // Simulate a production call with no token field — should get 400.
  // The emulator dev bypass only fires when FUNCTIONS_EMULATOR='true' AND body._dev != null.
  // Since we're calling the emulator, _dev IS the bypass. We test the validation path
  // by passing a body with no token and no _dev.
  const { status, body } = await post('/getInstructorSession', { not_token: 'garbage' })
  ok('status 400',      status === 400,  `got ${status}`)
  ok('error in body',   typeof body.error === 'string')
}

// ── T3: getRoster — empty instance ───────────────────────────────────────────

async function t3() {
  console.log('\nT3: getRoster _dev bypass, empty instance')
  const gameId = uid()
  await clearInstance(gameId)

  const { status, body } = await post('/getRoster', { _dev: { game_instance_id: gameId } })
  ok('status 200',           status === 200,              `got ${status}`)
  ok('ok: true',             body.ok === true)
  ok('participants = []',    Array.isArray(body.participants) && body.participants.length === 0)
  ok('groups = []',          Array.isArray(body.groups) && body.groups.length === 0)
}

// ── T4: getRoster — seeded instance ──────────────────────────────────────────

async function t4() {
  console.log('\nT4: getRoster _dev bypass, seeded instance with one matched group')
  const gameId = uid()
  await clearInstance(gameId)

  // Use seedGroupForTest to create a matched group + participants.
  const wmPids = [`wm1_${Date.now()}`, `wm2_${Date.now()}`]
  const hbPids = [`hb1_${Date.now()}`, `hb2_${Date.now()}`]
  const leadId = wmPids[0]
  const groupId = `grp_${Date.now()}`

  const { status: seedStatus, body: seedBody } = await post('/seedGroupForTest', {
    game_instance_id:        gameId,
    group_id:                groupId,
    lead_id:                 leadId,
    winemaster_participants: wmPids,
    home_base_participants:  hbPids,
  })
  if (seedStatus !== 200 || !seedBody.ok) {
    console.log(`  [SKIP] seedGroupForTest failed (${seedStatus}): ${JSON.stringify(seedBody)}`)
    console.log('         T4 requires seedGroupForTest endpoint (emulator only)')
    failed++
    return
  }

  // Seed attending entries so display_name is populated.
  await Promise.all([
    ...wmPids.map(pid => rtdb.ref(`attending/${gameId}/${pid}`).set({ display_name: `WM ${pid.slice(-4)}`, role: 'winemaster' })),
    ...hbPids.map(pid => rtdb.ref(`attending/${gameId}/${pid}`).set({ display_name: `HB ${pid.slice(-4)}`, role: 'home_base' })),
  ])

  const { status, body } = await post('/getRoster', { _dev: { game_instance_id: gameId } })
  ok('status 200',                      status === 200, `got ${status}`)
  ok('ok: true',                        body.ok === true)
  ok('4 participants returned',         body.participants?.length === 4,
     `got ${body.participants?.length}`)
  ok('1 group returned',                body.groups?.length === 1,
     `got ${body.groups?.length}`)

  const ps = body.participants ?? []
  const wmPs = ps.filter(p => p.role === 'winemaster')
  const hbPs = ps.filter(p => p.role === 'home_base')
  ok('2 winemaster participants',       wmPs.length === 2)
  ok('2 home_base participants',        hbPs.length === 2)
  ok('role_label for winemaster',       wmPs[0]?.role_label === 'Winemaster',
     `got: ${wmPs[0]?.role_label}`)
  ok('role_label for home_base',        hbPs[0]?.role_label === 'Home Base',
     `got: ${hbPs[0]?.role_label}`)
  ok('display_name populated',          ps.every(p => !p.display_name.includes('…')),
     `names: ${ps.map(p => p.display_name).join(', ')}`)
  ok('lead is_lead=true',               ps.find(p => p.participant_id === leadId)?.is_lead === true)
  ok('group_id stamped on participant', ps.every(p => p.group_id === groupId))
  ok('attended = true',                 ps.every(p => p.attended === true))

  const grp = body.groups[0]
  ok('group status = matched',          grp?.status === 'matched', `got: ${grp?.status}`)
  ok('group_id correct',                grp?.group_id === groupId)
  ok('participants_by_role.winemaster', JSON.stringify(grp?.participants_by_role?.winemaster?.sort()) === JSON.stringify(wmPids.sort()))
  ok('participants_by_role.home_base',  JSON.stringify(grp?.participants_by_role?.home_base?.sort()) === JSON.stringify(hbPids.sort()))

  await clearInstance(gameId)
}

// ── main ──────────────────────────────────────────────────────────────────────

;(async () => {
  console.log('=== B7a integration tests ===')
  await t1()
  await t2()
  await t3()
  await t4()
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
})()
