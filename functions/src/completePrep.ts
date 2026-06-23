import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentIds } from './engine/studentAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

async function markPrepComplete(gameInstanceId: string, participantId: string): Promise<void> {
  const ref = admin.firestore()
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)

  const snap = await ref.get()
  if (!snap.exists) {
    throw Object.assign(new Error('Participant not found.'), { status: 404 })
  }
  if (snap.data()?.prep_status === 'complete') return

  await ref.update({
    prep_status:       'complete',
    prep_completed_at: FieldValue.serverTimestamp(),
  })
}

/**
 * Marks a participant's preparation phase as complete.
 * Idempotent — safe to call on every mount of the hold screen.
 *
 * Request body: { token | _test }
 * Response: { ok: true }
 */
export const completePrep = onRequest(async (req, res) => {
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
    await markPrepComplete(gameInstanceId, participantId)
    res.json({ ok: true })
  } catch (err) {
    const status  = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})
