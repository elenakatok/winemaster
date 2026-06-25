/* eslint-disable */
'use strict'

// Integration test: seed participants via seedMatchTest, call triggerMatching,
// verify all eligible participants land in exactly one group.
// Run with: FIRESTORE_EMULATOR_HOST=localhost:8082 FIREBASE_DATABASE_EMULATOR_HOST=localhost:9002 node test/matchIntegration.cjs

const BASE = 'http://localhost:5005/winemaster-mygames-live/us-central1'

process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8082'
process.env.FIREBASE_DATABASE_EMULATOR_HOST = 'localhost:9002'

const admin = require('firebase-admin')
admin.initializeApp({
  projectId: 'winemaster-mygames-live',
  databaseURL: 'https://winemaster-mygames-live-default-rtdb.firebaseio.com',
})
const db = admin.firestore()

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: body }),
  })
  const json = await r.json()
  // Unwrap Firebase v2 onCall protocol
  if (json.result !== undefined) return json.result
  if (json.error !== undefined) {
    const errMsg = typeof json.error === 'string' ? json.error : (json.error.message ?? JSON.stringify(json.error))
    return { ok: false, error: errMsg }
  }
  return json  // onRequest (seedMatchTest) returns flat JSON
}

function makeParticipants(winemasters, homeBases) {
  const ps = []
  for (let i = 0; i < winemasters; i++) ps.push({ id: `w${i + 1}`, role: 'winemaster' })
  for (let i = 0; i < homeBases; i++) ps.push({ id: `h${i + 1}`, role: 'home_base' })
  return ps
}

async function readGroupsAndParticipants(gameId) {
  const [groupsSnap, psSnap] = await Promise.all([
    db.collection('game_instances').doc(gameId).collection('groups').get(),
    db.collection('game_instances').doc(gameId).collection('participants').get(),
  ])
  const groups = groupsSnap.docs.map(d => d.data())
  const participants = psSnap.docs.map(d => d.data())
  return { groups, participants }
}

function verify(label, gameId, nW, nH, triggerResult, groups, participants) {
  const errors = []
  const allPids = [
    ...Array.from({ length: nW }, (_, i) => `w${i + 1}`),
    ...Array.from({ length: nH }, (_, i) => `h${i + 1}`),
  ]

  // Every participant must appear in exactly one group.
  const pidToGroup = {}
  for (const g of groups) {
    for (const pid of [...(g.winemaster_participants || []), ...(g.home_base_participants || [])]) {
      if (pidToGroup[pid]) errors.push(`${pid} appears in multiple groups`)
      pidToGroup[pid] = g.group_id
    }
  }
  for (const pid of allPids) {
    if (!pidToGroup[pid]) errors.push(`${pid} not placed in any group`)
  }

  // Each group must have a valid lead_participant_id and outcome: null.
  for (const g of groups) {
    const allInGroup = [...(g.winemaster_participants || []), ...(g.home_base_participants || [])]
    if (!allInGroup.includes(g.lead_participant_id)) errors.push(`Group ${g.group_id} lead not in group`)
    if (g.outcome !== null) errors.push(`Group ${g.group_id} outcome !== null`)
    if (g.status !== 'matched') errors.push(`Group ${g.group_id} status !== matched`)
  }

  // Each participant doc must have group_id stamped.
  for (const p of participants) {
    if (!p.group_id) errors.push(`Participant ${p.participant_id} missing group_id`)
    if (p.group_id !== pidToGroup[p.participant_id]) errors.push(`Participant ${p.participant_id} group_id mismatch`)
  }

  // Exactly one is_lead per group.
  const leadsByGroup = {}
  for (const p of participants) {
    if (p.is_lead) {
      if (leadsByGroup[p.group_id]) errors.push(`Group ${p.group_id} has multiple leads`)
      leadsByGroup[p.group_id] = p.participant_id
    }
  }
  for (const g of groups) {
    if (!leadsByGroup[g.group_id]) errors.push(`Group ${g.group_id} has no lead participant doc`)
    if (leadsByGroup[g.group_id] !== g.lead_participant_id) {
      errors.push(`Group ${g.group_id} lead_participant_id mismatch between group doc and participant doc`)
    }
  }

  const status = errors.length === 0 ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${label}: ${nW}W+${nH}H → ${groups.length} group(s), ${allPids.length} participants placed`)
  if (errors.length > 0) {
    for (const e of errors) console.log(`       ✗ ${e}`)
  }
  return errors.length === 0
}

async function runCase(label, nW, nH) {
  const gameId = `test_${label.replace(/\+/g, '_')}_${Date.now()}`
  const participants = makeParticipants(nW, nH)
  const seedResult = await post('/seedMatchTest', { game_instance_id: gameId, participants })
  if (!seedResult.ok) { console.log(`[FAIL] ${label}: seed failed`, seedResult); return false }

  const triggerResult = await post('/triggerMatching', {
    game_instance_id: gameId,
    _dev: { game_instance_id: gameId },
  })
  if (!triggerResult.ok) { console.log(`[FAIL] ${label}: triggerMatching failed`, triggerResult); return false }

  const { groups, participants: pDocs } = await readGroupsAndParticipants(gameId)
  return verify(label, gameId, nW, nH, triggerResult, groups, pDocs)
}

async function runErrorCase(label, nW, nH) {
  const gameId = `test_err_${label.replace(/\+/g, '_')}_${Date.now()}`
  const participants = makeParticipants(nW, nH)
  await post('/seedMatchTest', { game_instance_id: gameId, participants })
  const result = await post('/triggerMatching', {
    game_instance_id: gameId,
    _dev: { game_instance_id: gameId },
  })
  const pass = result.ok === false && typeof result.error === 'string'
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${nW}W+${nH}H → expected error, got: ${JSON.stringify(result)}`)
  return pass
}

async function main() {
  console.log('\n── Winemaster triggerMatching integration tests ──\n')
  const results = await Promise.all([
    runCase('5W+5H', 5, 5),
    runCase('6W+4H', 6, 4),
    runCase('6W+2H', 6, 2),
    runCase('2W+2H', 2, 2),
    runCase('7W+5H', 7, 5),
  ])
  const errResult = await runErrorCase('1W+1H (error)', 1, 1)
  console.log('\n── Summary ──')
  const passed = results.filter(Boolean).length + (errResult ? 1 : 0)
  const total = results.length + 1
  console.log(`${passed}/${total} tests passed\n`)
  process.exit(passed === total ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
