'use strict'

// B8a integration tests: student-join backend functions
// syncRoster | assignRole | completePrep | confirmReady |
// generateAttendanceCode | verifyAttendanceCode
//
// Requires emulators: firebase emulators:start --only functions,firestore,database,auth
// Run: node test/b8aIntegration.cjs
//
// Tests:
//   T1: syncRoster → participant docs with prep_status:'not_started', no role
//       Re-run → idempotent; existing-with-role → skipped
//   T2: assignRole (_test) → balanced winemaster/home_base; idempotent (same pid → same role)
//       Custom token: uid = participant_id, claims { game_instance_id }, NO role claim
//   T3: completePrep → sets prep_status:'complete'; idempotent
//   T4: confirmReady → requires prep_status:'complete'; sets confirmed_ready_at; idempotent
//   T5: generateAttendanceCode (instructor) → 5-char code stored in Firestore
//       verifyAttendanceCode → rejects without confirmed_ready_at (full gate enforced)
//       verifyAttendanceCode → rejects wrong code; accepts correct code;
//       RTDB attending/ entry written with display_name + role
//   T6: End-to-end join: syncRoster → assignRole → completePrep → confirmReady →
//       generateAttendanceCode → verifyAttendanceCode → RTDB attending/ has role

process.env.FIRESTORE_EMULATOR_HOST  = 'localhost:8082'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9002'

const http  = require('http')
const admin = require('firebase-admin')

admin.initializeApp({
  projectId:   'winemaster-mygames-live',
  databaseURL: 'http://localhost:9002/?ns=winemaster-mygames-live',
})
const db   = admin.firestore()
const rtdb = admin.database()

const BASE      = 'http://localhost:5005/winemaster-mygames-live/us-central1'
const MOCK_PORT = 19010
const MOCK_URL  = `http://127.0.0.1:${MOCK_PORT}/getCourseRoster`
const MOCK_SECRET = 'test-secret-b8a'

let passed = 0, failed = 0

function ok(label, cond, detail = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passed++ }
  else       { console.log(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`); failed++ }
}

// ── Mock classroom roster server ──────────────────────────────────────────────

let mockRosterData = []   // overridden per test

const mockServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== MOCK_SECRET) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'bad secret' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, participants: mockRosterData }))
  })
})

async function startMock() {
  return new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r))
}
async function stopMock() {
  return new Promise((r) => mockServer.close(r))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  return { status: r.status, body: await r.json() }
}

function uid() { return `b8a_${Date.now()}_${Math.floor(Math.random() * 9999)}` }

async function clearInstance(gameId) {
  const ref = db.collection('game_instances').doc(gameId)
  const [ps, gs, ac] = await Promise.all([
    ref.collection('participants').get(),
    ref.collection('groups').get(),
    ref.collection('attendance_code').get(),
  ])
  const batch = db.batch()
  for (const d of [...ps.docs, ...gs.docs, ...ac.docs]) batch.delete(d.ref)
  if (ps.size + gs.size + ac.size > 0) await batch.commit()
}

// RTDB cleanup for T5/T6. If the RTDB emulator is absent, the remove() call
// hangs forever — wrap in a 2s race so tests can report a clean SKIP.
async function clearRtdb(gameId) {
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('rtdb-timeout')), 2000))
  await Promise.race([
    Promise.all([
      rtdb.ref(`attending/${gameId}`).remove(),
      rtdb.ref(`presence/${gameId}`).remove(),
    ]),
    timeout,
  ]).catch(() => {})
}

function decodeJwtPayload(token) {
  const [, b64] = token.split('.')
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
}

// ── T1: syncRoster ────────────────────────────────────────────────────────────

async function t1() {
  console.log('\nT1: syncRoster — creates placeholder docs; idempotent; skips role-holders')
  const gameId = uid()
  await clearInstance(gameId)

  const pid1 = uid() + '_s1'
  const pid2 = uid() + '_s2'
  const pid3 = uid() + '_s3'  // will be pre-seeded with a role

  // Pre-seed pid3 with a role (as if they self-joined via assignRole)
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid3)
    .set({ participant_id: pid3, game_instance_id: gameId, role: 'winemaster',
           prep_status: 'not_started' })

  mockRosterData = [
    { participant_id: pid1, name: 'Alice',   external_id: 'ext-001' },
    { participant_id: pid2, name: 'Bob',     external_id: 'ext-002' },
    { participant_id: pid3, name: 'Charlie', external_id: 'ext-003' },
  ]

  const { status, body } = await post('/syncRoster', {
    _dev: {
      game_instance_id: gameId,
      roster_url:       MOCK_URL,
      callback_secret:  MOCK_SECRET,
    },
  })

  ok('status 200', status === 200, `got ${status}`)
  ok('ok: true',   body.ok === true)
  ok('synced: 2',  body.synced  === 2, `got ${body.synced}`)
  ok('skipped: 1', body.skipped === 1, `got ${body.skipped}`)

  const snap1 = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid1).get()
  const d1 = snap1.data()
  ok('pid1 has prep_status not_started', d1?.prep_status === 'not_started')
  ok('pid1 has name Alice',              d1?.name === 'Alice')
  ok('pid1 has no role',                 d1?.role == null)

  const snap3 = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid3).get()
  ok('pid3 role not overwritten', snap3.data()?.role === 'winemaster')

  // Re-run — idempotent: synced=0, skipped=1 (pid3 still has role; pid1/pid2 now have name)
  const { body: body2 } = await post('/syncRoster', {
    _dev: {
      game_instance_id: gameId,
      roster_url:       MOCK_URL,
      callback_secret:  MOCK_SECRET,
    },
  })
  ok('second sync ok', body2.ok === true)
  ok('second sync skipped=1 (role-holder only)', body2.skipped === 1, `got ${body2.skipped}`)

  await clearInstance(gameId)
}

// ── T2: assignRole ────────────────────────────────────────────────────────────

async function t2() {
  console.log('\nT2: assignRole — balanced winemaster/home_base; idempotent; custom token claims')
  const gameId = uid()
  await clearInstance(gameId)

  const pids = Array.from({ length: 6 }, () => uid() + '_p')
  const roles = []

  // Assign 6 participants and collect roles
  for (const pid of pids) {
    const { status, body } = await post('/assignRole', {
      _test: { participant_id: pid, game_instance_id: gameId },
    })
    ok(`assignRole status 200 (${pid.slice(-6)})`, status === 200, `got ${status}`)
    roles.push(body.role)
  }

  const wmCount = roles.filter(r => r === 'winemaster').length
  const hbCount = roles.filter(r => r === 'home_base').length
  ok('6 assignments balanced: 3 winemaster', wmCount === 3, `got ${wmCount}`)
  ok('6 assignments balanced: 3 home_base',  hbCount === 3, `got ${hbCount}`)

  // Idempotency: same participant → same role
  const firstPid  = pids[0]
  const firstRole = roles[0]
  const { body: body2 } = await post('/assignRole', {
    _test: { participant_id: firstPid, game_instance_id: gameId },
  })
  ok('idempotent: same role on second call', body2.role === firstRole, `got ${body2.role}`)

  // Custom token claims: uid = participant_id, claims { game_instance_id }, NO role
  const { body: body3 } = await post('/assignRole', {
    _test: { participant_id: pids[0], game_instance_id: gameId },
  })
  ok('customToken present', typeof body3.customToken === 'string')
  ok('participant_id in response', body3.participant_id === pids[0])
  ok('game_instance_id in response', body3.game_instance_id === gameId)

  if (typeof body3.customToken === 'string') {
    const payload = decodeJwtPayload(body3.customToken)
    ok('customToken uid = participant_id',    payload.uid === pids[0], `uid=${payload.uid}`)
    ok('customToken claims.game_instance_id', payload.claims?.game_instance_id === gameId)
    ok('customToken has NO role claim',       payload.claims?.role == null,
       `claims=${JSON.stringify(payload.claims)}`)
  }

  await clearInstance(gameId)
}

// ── T3: completePrep ──────────────────────────────────────────────────────────

async function t3() {
  console.log('\nT3: completePrep — sets prep_status:complete; idempotent')
  const gameId = uid()
  const pid    = uid() + '_p'
  await clearInstance(gameId)

  // Seed participant (as if assignRole ran)
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid)
    .set({ participant_id: pid, game_instance_id: gameId, role: 'winemaster', prep_status: 'not_started' })

  const { status, body } = await post('/completePrep', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('status 200', status === 200, `got ${status}`)
  ok('ok: true',   body.ok === true)

  const snap = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).get()
  ok('prep_status is complete', snap.data()?.prep_status === 'complete')
  ok('prep_completed_at set',   snap.data()?.prep_completed_at != null)

  // Idempotency
  const { status: s2 } = await post('/completePrep', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('second call also 200', s2 === 200)

  await clearInstance(gameId)
}

// ── T4: confirmReady ──────────────────────────────────────────────────────────

async function t4() {
  console.log('\nT4: confirmReady — requires complete prep; sets confirmed_ready_at; idempotent')
  const gameId = uid()
  const pid    = uid() + '_p'
  await clearInstance(gameId)

  // Seed with prep NOT complete
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid)
    .set({ participant_id: pid, game_instance_id: gameId, role: 'winemaster', prep_status: 'not_started' })

  const { status: s400, body: b400 } = await post('/confirmReady', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('rejects if prep not complete (400)', s400 === 400, `got ${s400}: ${b400.error}`)

  // Now complete prep
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid)
    .update({ prep_status: 'complete' })

  const { status, body } = await post('/confirmReady', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('status 200', status === 200, `got ${status}`)
  ok('ok: true',   body.ok === true)

  const snap = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).get()
  ok('confirmed_ready_at set', snap.data()?.confirmed_ready_at != null)

  // Idempotency
  const { status: s2 } = await post('/confirmReady', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('second call also 200', s2 === 200)

  await clearInstance(gameId)
}

// ── T5: attendanceCode ────────────────────────────────────────────────────────

async function t5() {
  console.log('\nT5: attendanceCode — generate + verify (full gate)')
  const gameId = uid()
  const pid    = uid() + '_p'
  await clearInstance(gameId)
  await clearRtdb(gameId)

  // Seed with prep complete but NOT confirmed_ready_at
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid)
    .set({
      participant_id: pid, game_instance_id: gameId,
      role: 'home_base', display_name: 'TestStudent',
      prep_status: 'complete',
    })

  // Generate a code (instructor)
  const { status: gs, body: gb } = await post('/generateAttendanceCode', {
    _dev: { game_instance_id: gameId },
  })
  ok('generateAttendanceCode status 200', gs === 200, `got ${gs}`)
  ok('ok: true', gb.ok === true)
  const code = gb.code
  ok('code is 5 chars', typeof code === 'string' && code.length === 5, `code=${code}`)
  ok('code uses valid chars', /^[A-Z]+$/.test(code) && !/[ILO0]/.test(code), `code=${code}`)

  // Verify — should reject because confirmed_ready_at is NOT set (full gate enforced)
  const { status: s400, body: b400 } = await post('/verifyAttendanceCode', {
    _test: { participant_id: pid, game_instance_id: gameId },
    code,
  })
  ok('rejects without confirmed_ready_at (400)', s400 === 400, `got ${s400}: ${b400.error}`)

  // Set confirmed_ready_at
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid)
    .update({ confirmed_ready_at: admin.firestore.FieldValue.serverTimestamp() })

  // Verify with wrong code
  const { status: s400b } = await post('/verifyAttendanceCode', {
    _test: { participant_id: pid, game_instance_id: gameId },
    code: 'ZZZZZ',
  })
  ok('rejects wrong code (400)', s400b === 400, `got ${s400b}`)

  // Verify with correct code
  const { status: sv, body: bv } = await post('/verifyAttendanceCode', {
    _test: { participant_id: pid, game_instance_id: gameId },
    code,
  })
  ok('correct code: status 200',  sv === 200, `got ${sv}`)
  ok('correct code: ok: true',    bv.ok === true)

  const snap = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).get()
  ok('attendance_confirmed_at set', snap.data()?.attendance_confirmed_at != null)

  // RTDB attending/ entry written
  const rtdbTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('rtdb-timeout')), 3000))
  const attendingVal = await Promise.race([
    rtdb.ref(`attending/${gameId}/${pid}`).get().then(s => s.val()),
    rtdbTimeout,
  ]).catch(() => null)
  ok('RTDB attending entry exists',          attendingVal != null, 'RTDB emulator required for this check')
  ok('RTDB attending.display_name correct',  attendingVal?.display_name === 'TestStudent', `got ${attendingVal?.display_name}`)
  ok('RTDB attending.role correct',          attendingVal?.role === 'home_base', `got ${attendingVal?.role}`)
  ok('RTDB attending.confirmed_at present',  typeof attendingVal?.confirmed_at === 'number')

  // Idempotency: second verify call is a no-op (200)
  const { status: si } = await post('/verifyAttendanceCode', {
    _test: { participant_id: pid, game_instance_id: gameId },
    code,
  })
  ok('idempotent: second verify also 200', si === 200)

  await clearInstance(gameId)
  await clearRtdb(gameId)
}

// ── T6: End-to-end join ───────────────────────────────────────────────────────

async function t6() {
  console.log('\nT6: End-to-end join: syncRoster → assignRole → completePrep → confirmReady → generateCode → verifyCode → RTDB attending/')
  const gameId = uid()
  await clearInstance(gameId)

  const pid  = uid() + '_student'
  const name = 'End-to-End Student'

  // 1. Sync roster — creates placeholder doc
  mockRosterData = [{ participant_id: pid, name, external_id: null }]
  const { body: syncBody } = await post('/syncRoster', {
    _dev: {
      game_instance_id: gameId,
      roster_url:       MOCK_URL,
      callback_secret:  MOCK_SECRET,
    },
  })
  ok('syncRoster ok', syncBody.ok === true)
  ok('synced 1',      syncBody.synced === 1)

  const preSnap = await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).get()
  ok('after sync: no role', preSnap.data()?.role == null)

  // 2. assignRole — student joins, gets a role + custom token
  const { status: as, body: ab } = await post('/assignRole', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('assignRole 200', as === 200, `got ${as}`)
  const role = ab.role
  ok('role is winemaster or home_base',
    role === 'winemaster' || role === 'home_base', `got ${role}`)

  // Set display_name (would normally happen via Phase1NameEntry)
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid)
    .update({ display_name: name })

  // 3. completePrep
  const { status: cs } = await post('/completePrep', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('completePrep 200', cs === 200, `got ${cs}`)

  // 4. confirmReady
  const { status: crs } = await post('/confirmReady', {
    _test: { participant_id: pid, game_instance_id: gameId },
  })
  ok('confirmReady 200', crs === 200, `got ${crs}`)

  // 5. generateAttendanceCode (instructor)
  const { body: gb } = await post('/generateAttendanceCode', {
    _dev: { game_instance_id: gameId },
  })
  ok('generateCode ok', gb.ok === true)
  const code = gb.code

  // 6. verifyAttendanceCode (student)
  const { status: vs, body: vb } = await post('/verifyAttendanceCode', {
    _test: { participant_id: pid, game_instance_id: gameId },
    code,
  })
  ok('verifyAttendanceCode 200', vs === 200, `got ${vs}: ${vb.error ?? ''}`)
  ok('verify ok: true', vb.ok === true)

  // Confirm: RTDB attending/ has the correct role → eligible for triggerMatching
  const rtdbTimeout2 = new Promise((_, rej) => setTimeout(() => rej(new Error('rtdb-timeout')), 3000))
  const attendVal = await Promise.race([
    rtdb.ref(`attending/${gameId}/${pid}`).get().then(s => s.val()),
    rtdbTimeout2,
  ]).catch(() => null)
  ok('RTDB attending entry exists',     attendVal != null, 'RTDB emulator required for this check')
  ok('RTDB attending.role matches',     attendVal?.role === role, `expected ${role}, got ${attendVal?.role}`)
  ok('RTDB attending.display_name set', attendVal?.display_name === name)

  await clearInstance(gameId)
  await clearRtdb(gameId)
}

// ── RTDB / auth availability checks ──────────────────────────────────────────

async function rtdbAvailable() {
  try {
    await Promise.race([
      rtdb.ref('.info/connected').get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ])
    return true
  } catch { return false }
}

async function authAvailable() {
  try {
    // createCustomToken is only available when the auth emulator is running.
    await Promise.race([
      admin.auth().createCustomToken('probe-uid'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ])
    return true
  } catch { return false }
}

// ── Main ──────────────────────────────────────────────────────────────────────

;(async () => {
  await startMock()
  const [hasRtdb, hasAuth] = await Promise.all([rtdbAvailable(), authAvailable()])

  try {
    await t1()

    if (hasAuth) {
      await t2()
    } else {
      console.log('\nT2: assignRole — SKIPPED (auth emulator not running; use --only functions,firestore,database,auth)')
    }

    await t3()
    await t4()

    if (hasRtdb && hasAuth) {
      await t5()
      await t6()
    } else {
      const missing = [!hasAuth && 'auth', !hasRtdb && 'database'].filter(Boolean).join(', ')
      console.log(`\nT5/T6: attendanceCode + e2e — SKIPPED (missing emulators: ${missing})`)
    }
  } finally {
    await stopMock()
    await admin.app().delete()
  }
  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})()
