import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentIds } from './engine/studentAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

async function markReadyConfirmed(gameInstanceId: string, participantId: string): Promise<void> {
  const ref = admin.firestore()
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)

  const snap = await ref.get()
  if (!snap.exists) {
    throw Object.assign(new Error('Participant not found.'), { status: 404 })
  }

  const data = snap.data()!
  if (data.prep_status !== 'complete') {
    throw Object.assign(new Error('Preparation not complete.'), { status: 400 })
  }
  if (data.confirmed_ready_at != null) return

  await ref.update({ confirmed_ready_at: FieldValue.serverTimestamp() })
}

/**
 * Records that a participant has confirmed they are present and ready to
 * enter live session. Requires prep_status === 'complete'.
 * Idempotent. This is the gate verifyAttendanceCode requires.
 *
 * Request body: { token | _test }
 * Response: { ok: true }
 */
export const confirmReady = onRequest(async (req, res) => {
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
  const ids = await extractStudentIds(body, isEmulator, res, req.headers.authorization)
  if (!ids) return
  const { participantId, gameInstanceId } = ids

  try {
    await markReadyConfirmed(gameInstanceId, participantId)
    res.json({ ok: true })
  } catch (err) {
    const status  = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})
