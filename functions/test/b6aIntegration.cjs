'use strict'

// B6a integration tests: pushResultsToClassroom + reportResult dispatch utilities
// Requires emulators running: firebase emulators:start --only functions,firestore
// Run with: node test/b6aIntegration.cjs
//
// Strategy:
//   T1-T4: lib-level — import compiled dispatchResults/reportResult directly,
//          no emulator needed, no env setup.
//   T5-T7: HTTP endpoint — call pushResultsToClassroom via emulator,
//          inject mock URL via _dev.callback_url override.

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8082'

const http   = require('http')
const admin  = require('firebase-admin')
admin.initializeApp({ projectId: 'winemaster-mygames-live' })
const db = admin.firestore()

const BASE   = 'http://localhost:5005/winemaster-mygames-live/us-central1'
const MOCK_PORT = 19009
const MOCK_URL  = `http://127.0.0.1:${MOCK_PORT}/callback`
const TEST_SECRET = 'test-secret-b6a'

// ── Compiled lib (built from src/engine/reportResult.ts) ──────────────────────
const { reportResult, dispatchResults } = require('../lib/engine/reportResult')

let passed = 0, failed = 0

function ok(label, cond, detail = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passed++ }
  else       { console.log(`  [FAIL] ${label}${detail ? ': ' + detail : ''}`); failed++ }
}

// ── Mock HTTP server ──────────────────────────────────────────────────────────

let mockHandler = (req, res, body) => res.end(JSON.stringify({ ok: true }))
let received = []   // cleared per test

const mockServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => raw += c)
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { /* ignore */ }
    received.push({ method: req.method, path: req.url, headers: req.headers, body: parsed })
    mockHandler(req, res, parsed)
  })
})

async function startMock() {
  return new Promise(r => mockServer.listen(MOCK_PORT, '127.0.0.1', r))
}

async function stopMock() {
  return new Promise(r => mockServer.close(r))
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: body }),
  })
  const json = await r.json()
  let unwrapped
  if (json.result !== undefined) {
    unwrapped = json.result
  } else if (json.error !== undefined) {
    const errMsg = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error))
    unwrapped = { ok: false, error: errMsg }
  } else {
    unwrapped = json
  }
  return { status: r.status, body: unwrapped }
}

// ── Firestore seed helpers ───────────────────────────────────────────────────

function uid() { return `b6a_${Date.now()}_${Math.floor(Math.random()*9999)}` }

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

async function seedFinalized(gameId, pid, role, rawScore, normalizedScore) {
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).set({
      participant_id:        pid,
      game_instance_id:      gameId,
      role,
      raw_score:             rawScore,
      normalized_score:      normalizedScore,
      knowledge_check_score: null,
      finalized_at:          admin.firestore.FieldValue.serverTimestamp(),
    })
}

async function seedUnfinalized(gameId, pid, role) {
  await db.collection('game_instances').doc(gameId)
    .collection('participants').doc(pid).set({
      participant_id:   pid,
      game_instance_id: gameId,
      role,
      // finalized_at absent → should be skipped by pushResultsToClassroom
    })
}

// ── Lib-level record builder (mirrors what pushResultsToClassroom builds) ────

function makeRecord(gameId, pid, role, rawScore, normalizedScore, status = null) {
  return {
    game_instance_id:      gameId,
    participant_id:        pid,
    status:                status ?? (rawScore != null ? 'completed' : 'no_show'),
    role,
    normalized_score:      normalizedScore,
    knowledge_check_score: null,
    details:               {},
    // raw_score intentionally absent
  }
}

// ── T1: Payload shape + auth header + no raw_score (lib-level) ───────────────

async function testPayloadShape() {
  console.log('\n[T1] Payload shape, auth header, no raw_score')

  received = []
  mockHandler = (req, res) => res.end(JSON.stringify({ ok: true }))

  const gameId = 'g_shape'
  const records = [
    makeRecord(gameId, 'w1', 'winemaster', 2_375_000,  0.866),   // deal
    makeRecord(gameId, 'w3', 'winemaster',         0, -0.866),   // walk-away (completed, in pool)
    makeRecord(gameId, 'w5', 'winemaster',      null,    -2),     // no-show
    makeRecord(gameId, 'h1', 'home_base',   2_675_000, -0.866),   // deal
    makeRecord(gameId, 'h3', 'home_base',   1_000_000,  0.866),   // walk-away PROVISIONAL
    makeRecord(gameId, 'h5', 'home_base',        null,    -2),    // no-show
  ]

  const summary = await dispatchResults(records, MOCK_URL, TEST_SECRET, undefined, [0, 0])
  ok('6 records dispatched', summary.total === 6, summary.total)
  ok('all succeeded',        summary.succeeded === 6, summary.succeeded)
  ok('no failures',          summary.failed.length === 0)
  ok('mock received 6',      received.length === 6, received.length)

  // Pick the first received record for shape checks
  const first = received[0]
  ok('method POST',               first.method === 'POST')
  ok('path /callback',            first.path   === '/callback')
  ok('Content-Type json',         first.headers['content-type']?.includes('application/json'))
  ok('Authorization: Bearer ...',
     first.headers['authorization'] === `Bearer ${TEST_SECRET}`)

  // Verify every record has the required fields and NO raw_score
  for (const rx of received) {
    const b = rx.body
    ok(`${b.participant_id} has game_instance_id`,    'game_instance_id'      in b)
    ok(`${b.participant_id} has participant_id`,      'participant_id'         in b)
    ok(`${b.participant_id} has status`,              'status'                 in b)
    ok(`${b.participant_id} has role`,                'role'                   in b)
    ok(`${b.participant_id} has normalized_score`,    'normalized_score'       in b)
    ok(`${b.participant_id} has knowledge_check_score`, 'knowledge_check_score' in b)
    ok(`${b.participant_id} has details`,             'details'                in b)
    ok(`${b.participant_id} NO raw_score`,            !('raw_score'            in b),
       `raw_score present: ${JSON.stringify(b.raw_score)}`)
  }

  // Status derivation
  const byId = Object.fromEntries(received.map(r => [r.body.participant_id, r.body]))
  ok('w1 status=completed',  byId['w1'].status === 'completed')
  ok('w3 status=completed (walk-away, in pool)', byId['w3'].status === 'completed')
  ok('w5 status=no_show',    byId['w5'].status === 'no_show')
  ok('h1 status=completed',  byId['h1'].status === 'completed')
  ok('h3 status=completed (walk-away, PROVISIONAL)', byId['h3'].status === 'completed')
  ok('h5 status=no_show',    byId['h5'].status === 'no_show')
}

// ── T2: 5xx retry (lib-level) ────────────────────────────────────────────────

async function test5xxRetry() {
  console.log('\n[T2] 5xx retry: retries on 500, succeeds on second attempt')

  received = []
  let p1CallCount = 0
  mockHandler = (req, res, body) => {
    if (body?.participant_id === 'p1') {
      p1CallCount++
      if (p1CallCount === 1) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'server error' })); return
      }
    }
    res.end(JSON.stringify({ ok: true }))
  }

  const gameId = 'g_retry'
  const records = [
    makeRecord(gameId, 'p1', 'winemaster', 1000, 0.5),
    makeRecord(gameId, 'p2', 'home_base',  2000, -0.5),
  ]

  const summary = await dispatchResults(records, MOCK_URL, TEST_SECRET, undefined, [0, 0])
  ok('total=2',         summary.total     === 2)
  ok('succeeded=2',     summary.succeeded === 2, summary.succeeded)
  ok('no failures',     summary.failed.length === 0)
  ok('p1 called twice (1 retry after 500)', p1CallCount === 2, p1CallCount)
  ok('mock received 3 total (2 for p1, 1 for p2)', received.length === 3, received.length)
}

// ── T3: 4xx fail-fast + partial success (lib-level) ──────────────────────────

async function test4xxFailFast() {
  console.log('\n[T3] 4xx fail-fast: 403 fails immediately, other records still succeed')

  received = []
  let p1CallCount = 0
  mockHandler = (req, res, body) => {
    if (body?.participant_id === 'p1_bad') {
      p1CallCount++
      res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return
    }
    res.end(JSON.stringify({ ok: true }))
  }

  const gameId = 'g_4xx'
  const records = [
    makeRecord(gameId, 'p1_bad', 'winemaster', null, -2),   // will 403
    makeRecord(gameId, 'p2_ok',  'home_base',  1500, 0.3),  // will succeed
    makeRecord(gameId, 'p3_ok',  'winemaster', 2000, 0.7),  // will succeed
  ]

  const summary = await dispatchResults(records, MOCK_URL, TEST_SECRET, undefined, [0, 0])
  ok('total=3',                           summary.total     === 3)
  ok('succeeded=2',                       summary.succeeded === 2, summary.succeeded)
  ok('failed=1',                          summary.failed.length === 1, summary.failed.length)
  ok('failed participant is p1_bad',      summary.failed[0]?.participant_id === 'p1_bad',
     summary.failed[0]?.participant_id)
  ok('fail reason mentions HTTP 403',     summary.failed[0]?.reason.includes('403'),
     summary.failed[0]?.reason)
  ok('p1_bad called only once (no retry on 4xx)', p1CallCount === 1, p1CallCount)
  ok('mock received 3 total (1 bad + 2 good)',     received.length === 3, received.length)
}

// ── T4: No-op — reportResult silently skips empty URL (lib-level) ────────────

async function testNoOp() {
  console.log('\n[T4] No-op: empty callbackUrl → no request made, no throw')

  received = []

  // Call reportResult directly with empty URL.
  await reportResult(
    { game_instance_id: 'g_noop', participant_id: 'p1', status: 'completed',
      role: 'winemaster', normalized_score: 0.5, knowledge_check_score: null, details: {} },
    '',          // empty URL
    TEST_SECRET,
  )
  ok('no request sent to mock',  received.length === 0, received.length)

  // dispatchResults with empty URL also no-ops (reportResult called but returns immediately).
  const records = [makeRecord('g_noop', 'px', 'winemaster', 1000, 0.5)]
  const summary = await dispatchResults(records, '', TEST_SECRET, undefined, [0, 0])
  ok('dispatchResults with empty URL returns total=1', summary.total === 1)
  ok('dispatchResults with empty URL: succeeded=1 (no throw = ok)', summary.succeeded === 1)
  ok('still no requests to mock', received.length === 0, received.length)
}

// ── T5: HTTP endpoint — full push (role filter + finalized_at filter + auth) ─

async function testHttpEndpointFullPush() {
  console.log('\n[T5] HTTP endpoint: role filter, finalized_at filter, walk-away, no-show')

  const gameId = uid()
  await clearInstance(gameId)

  // Finalized participants (should be pushed).
  await seedFinalized(gameId, 'w1', 'winemaster',  2_375_000,  0.866)  // deal
  await seedFinalized(gameId, 'w2', 'winemaster',  2_375_000,  0.866)  // deal
  await seedFinalized(gameId, 'w3', 'winemaster',          0, -0.866)  // walk-away
  await seedFinalized(gameId, 'w5', 'winemaster',       null,    -2)   // no-show
  await seedFinalized(gameId, 'h1', 'home_base',   2_675_000, -0.866)  // deal
  await seedFinalized(gameId, 'h3', 'home_base',   1_000_000,  0.866)  // walk-away PROVISIONAL
  await seedFinalized(gameId, 'h5', 'home_base',        null,    -2)   // no-show

  // Participants that must NOT be pushed.
  await seedUnfinalized(gameId, 'u_unfinalized', 'winemaster')    // no finalized_at
  await seedFinalized(gameId, 'u_badrole', 'instructor', 0, 0)    // unexpected role

  received = []
  mockHandler = (req, res) => res.end(JSON.stringify({ ok: true }))

  const r = await post('/pushResultsToClassroom', {
    _dev: {
      game_instance_id: gameId,
      callback_url:     MOCK_URL,
      callback_secret:  TEST_SECRET,
    },
  })

  ok('HTTP 200',    r.status === 200, r.status)
  ok('ok:true',     r.body.ok === true)
  ok('total=7',     r.body.total === 7, r.body.total)       // 7 finalized with valid roles
  ok('succeeded=7', r.body.succeeded === 7, r.body.succeeded)
  ok('no failures', r.body.failed?.length === 0, r.body.failed?.length)

  ok('mock received 7 posts', received.length === 7, received.length)

  const byId = Object.fromEntries(received.map(r => [r.body.participant_id, r.body]))

  // Unfinalized and bad-role participants must be absent
  ok('unfinalized participant skipped', !('u_unfinalized' in byId))
  ok('instructor role skipped',         !('u_badrole'     in byId))

  // Status derivation
  ok('w1 completed', byId['w1']?.status === 'completed')
  ok('w3 completed (walk-away)', byId['w3']?.status === 'completed')
  ok('w5 no_show',   byId['w5']?.status === 'no_show')
  ok('h1 completed', byId['h1']?.status === 'completed')
  ok('h3 completed (walk-away PROVISIONAL)', byId['h3']?.status === 'completed')
  ok('h5 no_show',   byId['h5']?.status === 'no_show')

  // No raw_score on any received record
  for (const pid of ['w1','w2','w3','w5','h1','h3','h5']) {
    ok(`${pid} no raw_score in payload`, !('raw_score' in (byId[pid] ?? {})))
  }

  // Auth header on all requests
  for (const rx of received) {
    ok(`${rx.body.participant_id} has Bearer auth`,
       rx.headers['authorization'] === `Bearer ${TEST_SECRET}`)
  }
}

// ── T6: HTTP endpoint no-op (missing callback URL) ────────────────────────────

async function testHttpEndpointNoOp() {
  console.log('\n[T6] HTTP endpoint no-op: missing callback URL → ok:true, total:0, no POST')

  const gameId = uid()
  await clearInstance(gameId)
  await seedFinalized(gameId, 'pX', 'winemaster', 1000, 0.5)

  received = []

  // Pass explicit empty callback_url to force the no-op guard regardless of env vars.
  const r = await post('/pushResultsToClassroom', {
    _dev: {
      game_instance_id: gameId,
      callback_url: '',  // empty string → no-op (env var might be set in .env.local)
    },
  })

  ok('HTTP 200',    r.status === 200, `${r.status} ${JSON.stringify(r.body)}`)
  ok('ok:true',     r.body.ok === true)
  ok('total=0',     r.body.total === 0, r.body.total)
  ok('mock received 0 posts', received.length === 0, received.length)
}

// ── T7: HTTP endpoint partial failure ─────────────────────────────────────────

async function testHttpEndpointPartialFail() {
  console.log('\n[T7] HTTP endpoint: partial failure reported in response')

  const gameId = uid()
  await clearInstance(gameId)
  await seedFinalized(gameId, 'pA', 'winemaster', 2000, 0.5)
  await seedFinalized(gameId, 'pB', 'home_base',  null,  -2)
  await seedFinalized(gameId, 'pC', 'winemaster', 1500, -0.3)

  received = []
  mockHandler = (req, res, body) => {
    if (body?.participant_id === 'pB') {
      res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })); return
    }
    res.end(JSON.stringify({ ok: true }))
  }

  const r = await post('/pushResultsToClassroom', {
    _dev: {
      game_instance_id: gameId,
      callback_url:     MOCK_URL,
      callback_secret:  TEST_SECRET,
    },
  })

  ok('HTTP 200',           r.status === 200)
  ok('ok:true',            r.body.ok === true)
  ok('total=3',            r.body.total     === 3, r.body.total)
  ok('succeeded=2',        r.body.succeeded === 2, r.body.succeeded)
  ok('failed=1',           r.body.failed?.length === 1, r.body.failed?.length)
  ok('failed is pB',       r.body.failed?.[0]?.participant_id === 'pB',
     r.body.failed?.[0]?.participant_id)
}

// ── Runner ─────────────────────────────────────────────────────────────────────

;(async () => {
  await startMock()
  console.log(`Mock classroom server listening on :${MOCK_PORT}`)

  try {
    await testPayloadShape()
    await test5xxRetry()
    await test4xxFailFast()
    await testNoOp()
    await testHttpEndpointFullPush()
    await testHttpEndpointNoOp()
    await testHttpEndpointPartialFail()
  } catch (err) {
    console.error('\nUnhandled error:', err)
    failed++
  }

  await stopMock()
  console.log(`\n── B6a Integration ── ${passed} passed, ${failed} failed ──`)
  process.exit(failed > 0 ? 1 : 0)
})()
