import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { roleKeys } from '@mygames/game-engine'
import { winemasterConfig } from './gameDefinition'
import { extractInstructorGameId } from './engine/instructorAuth'
import { dispatchResults, type GameResult } from './engine/reportResult'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])
const VALID_ROLES = new Set(roleKeys(winemasterConfig))

export const pushResultsToClassroom = onRequest(async (req, res) => {
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
  const gameInstanceId = await extractInstructorGameId(body, isEmulator, res, req.headers.authorization)
  if (gameInstanceId === null) return

  // Dev: _dev.callback_url and _dev.callback_secret override env vars in emulator mode.
  // This lets integration tests inject a local mock endpoint without env/restart gymnastics.
  const devBody = isEmulator && body._dev != null ? body._dev as Record<string, unknown> : null
  const callbackUrl    = (devBody?.callback_url    as string | undefined) ?? process.env.CLASSROOM_CALLBACK_URL    ?? ''
  const callbackSecret = (devBody?.callback_secret as string | undefined) ?? process.env.CLASSROOM_CALLBACK_SECRET ?? ''

  if (!callbackUrl) {
    console.warn('[pushResultsToClassroom] CLASSROOM_CALLBACK_URL not configured — no-op')
    res.json({ ok: true, total: 0, succeeded: 0, failed: [] })
    return
  }

  try {
    const db = admin.firestore()
    const snap = await db
      .collection('game_instances')
      .doc(gameInstanceId)
      .collection('participants')
      .get()

    const records: GameResult[] = []
    for (const doc of snap.docs) {
      const d = doc.data()

      // Only push participants that have been through finalizeInstance.
      if (d['finalized_at'] == null) continue

      // Skip participants with unrecognised roles (instructors, legacy data, etc.).
      const role = d['role'] as string | null
      if (role == null || !VALID_ROLES.has(role)) continue

      // no_show participants have raw_score=null (set by computeZScoresByRole).
      // Walk-aways have a raw_score (provisional sentinel or real value) → 'completed'.
      const status: GameResult['status'] = d['raw_score'] != null ? 'completed' : 'no_show'

      records.push({
        game_instance_id:      gameInstanceId,
        participant_id:        doc.id,
        status,
        role,
        normalized_score:      (d['normalized_score'] ?? null) as number | null,
        knowledge_check_score: (d['knowledge_check_score'] ?? null) as number | null,
        details:               {},
        // raw_score intentionally omitted — scores-only gradebook contract
      })
    }

    const summary = await dispatchResults(records, callbackUrl, callbackSecret)
    res.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[pushResultsToClassroom] error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
