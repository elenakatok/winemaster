import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'

admin.initializeApp()

export { triggerMatching } from './triggerMatching'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') {
    res.status(204).send('')
    return
  }
  res.json({ ok: true, game: 'winemaster' })
})

// Emulator-only: seed participants and RTDB presence for triggerMatching tests.
export const seedMatchTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const body = req.body as { game_instance_id?: unknown; participants?: unknown }

  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' })
    return
  }
  if (!Array.isArray(body.participants)) {
    res.status(400).json({ error: 'participants array required' })
    return
  }

  type SeedP = { id: string; role: 'winemaster' | 'home_base' }
  const gameInstanceId = body.game_instance_id
  const participants = body.participants as SeedP[]

  const db = admin.firestore()
  const rtdb = admin.database()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const now = Timestamp.now()

  // Clear existing participants and groups for a clean test run.
  const [existingPs, existingGs] = await Promise.all([
    instanceRef.collection('participants').get(),
    instanceRef.collection('groups').get(),
  ])
  if (existingPs.size > 0 || existingGs.size > 0) {
    const clearBatch = db.batch()
    for (const d of existingPs.docs) clearBatch.delete(d.ref)
    for (const d of existingGs.docs) clearBatch.delete(d.ref)
    await clearBatch.commit()
  }
  await rtdb.ref(`presence/${gameInstanceId}`).remove()

  // Seed participant docs and RTDB presence.
  const seedBatch = db.batch()
  const presenceData: Record<string, unknown> = {}
  for (const p of participants) {
    seedBatch.set(instanceRef.collection('participants').doc(p.id), {
      participant_id: p.id,
      game_instance_id: gameInstanceId,
      role: p.role,
      prep_status: 'complete',
      attendance_confirmed_at: now,
      confirmed_ready_at: now,
    })
    presenceData[p.id] = { online: true, last_seen: now.toMillis() }
  }
  await seedBatch.commit()
  await rtdb.ref(`presence/${gameInstanceId}`).set(presenceData)

  res.json({ ok: true, seeded: participants.length })
})
