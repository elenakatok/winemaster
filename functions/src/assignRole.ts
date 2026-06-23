import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { roleKeys } from '@mygames/game-engine'
import { verifyClassroomToken } from './engine/verifyToken'
import { winemasterConfig } from './gameDefinition'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])
const ROLE_KEYS = roleKeys(winemasterConfig)  // ['winemaster', 'home_base']

/**
 * Atomically assigns a role to a participant within a game instance.
 *
 * - Idempotent: re-calling returns the already-assigned role without touching counts.
 * - Balanced: assigns whichever role is currently behind (first declared role on tie).
 * - Atomic: Firestore transaction prevents concurrent double-assignment.
 *
 * Firestore paths written:
 *   game_instances/{id}/participants/{pid}  — role, role_assigned_at
 *   game_instances/{id}/role_counts/totals  — running counters keyed by role key
 */
async function doAssignRole(gameInstanceId: string, participantId: string): Promise<string> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)
  const countsRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('role_counts').doc('totals')

  return db.runTransaction(async (tx) => {
    const [participantSnap, countsSnap] = await Promise.all([
      tx.get(participantRef),
      tx.get(countsRef),
    ])

    const existing = participantSnap.data()
    if (existing?.role) return existing.role as string

    const counts = (countsSnap.data() ?? {}) as Record<string, number>
    // Pick the role with the fewest assignments; first declared role wins a tie.
    let minRole  = ROLE_KEYS[0]
    let minCount = counts[ROLE_KEYS[0]] ?? 0
    for (const key of ROLE_KEYS.slice(1)) {
      const c = counts[key] ?? 0
      if (c < minCount) { minRole = key; minCount = c }
    }
    const role = minRole
    const now  = FieldValue.serverTimestamp()

    if (participantSnap.exists) {
      tx.update(participantRef, { role, role_assigned_at: now })
    } else {
      tx.set(participantRef, {
        participant_id:   participantId,
        game_instance_id: gameInstanceId,
        role,
        role_assigned_at: now,
        prep_status:      'not_started',
      })
    }
    tx.set(countsRef, { [role]: (counts[role] ?? 0) + 1 }, { merge: true })
    return role
  })
}

/**
 * Exchanges a classroom student JWT for a role assignment + Firebase custom token.
 *
 * - Verifies the classroom JWT (RS256, kid: classroom-v1).
 * - Runs balanced role assignment via Firestore transaction.
 * - Mints a Firebase custom token: uid = participant_id, claims { game_instance_id }.
 *   Note: NO role in claims — student tokens differ from instructor tokens.
 *
 * Request body (emulator): { _test: { participant_id, game_instance_id } }
 * Request body (production): { token: "<student classroom JWT>" }
 * Response: { ok, role, customToken, participant_id, game_instance_id }
 */
export const assignRole = onRequest(async (req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

  let participantId: string
  let gameInstanceId: string

  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return
    }
    participantId = test.participant_id
    gameInstanceId = test.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    try {
      const payload = verifyClassroomToken(body.token)
      participantId  = payload.participant_id
      gameInstanceId = payload.game_instance_id
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
  }

  try {
    const role = await doAssignRole(gameInstanceId, participantId)
    const customToken = await admin.auth().createCustomToken(participantId, {
      game_instance_id: gameInstanceId,
    })
    res.json({ ok: true, role, customToken, participant_id: participantId, game_instance_id: gameInstanceId })
  } catch (err) {
    console.error('assignRole error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
