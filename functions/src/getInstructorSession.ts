import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { verifyClassroomToken } from './engine/verifyToken'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

/**
 * Exchanges an instructor classroom JWT for a Firebase custom token.
 * The custom token lets the instructor dashboard hold an auto-refreshing
 * Firebase session (via signInWithCustomToken) for Bearer auth on all
 * subsequent instructor-gated function calls.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Request body (production): { token: "<instructor classroom JWT>" }
 * Response: { ok: true, customToken }
 */
export const getInstructorSession = onRequest(async (req, res) => {
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
  let gameInstanceId: string

  if (isEmulator && body._dev != null) {
    const dev = body._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      res.status(400).json({ error: '_dev requires game_instance_id' })
      return
    }
    gameInstanceId = dev.game_instance_id
  } else {
    if (typeof body.token !== 'string') {
      res.status(400).json({ error: 'Missing token' })
      return
    }
    let payload
    try {
      payload = verifyClassroomToken(body.token)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return
    }
    if (payload.role !== 'instructor') {
      res.status(403).json({ ok: false, error: 'not instructor' })
      return
    }
    gameInstanceId = payload.game_instance_id
  }

  try {
    const uid = `instructor_${gameInstanceId}`
    const customToken = await admin.auth().createCustomToken(uid, {
      role: 'instructor',
      game_instance_id: gameInstanceId,
    })
    res.json({ ok: true, customToken })
  } catch (err) {
    console.error('[getInstructorSession] error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
