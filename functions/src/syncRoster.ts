import { onRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from './engine/instructorAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

/**
 * Fetches the classroom enrollment roster and pre-populates participant docs
 * so the instructor sees all enrolled students before they self-join.
 *
 * Merge rule: docs that already have a role (student has self-joined via
 * assignRole) are never touched. Only creates new rows or refreshes
 * name/external_id on existing role-less rows. No deletions. Idempotent.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Request body (production): { token: "<instructor JWT>" }
 * Dev overrides: _dev.roster_url, _dev.callback_secret — inject mock endpoint in tests.
 * Response: { ok, synced, skipped }
 */
export const syncRoster = onRequest(
  { secrets: [classroomCallbackSecret] },
  async (req, res) => {
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
    if (!gameInstanceId) return

    const devBody = isEmulator && body._dev != null ? body._dev as Record<string, unknown> : null
    const rosterUrl      = (devBody?.roster_url      as string | undefined) ?? process.env.CLASSROOM_ROSTER_URL      ?? ''
    const callbackSecret = (devBody?.callback_secret as string | undefined) ?? process.env.CLASSROOM_CALLBACK_SECRET ?? ''

    console.log('[syncRoster] config check', {
      has_roster_url:      !!rosterUrl,
      has_callback_secret: !!callbackSecret,
      game_instance_id:    gameInstanceId,
    })

    if (!rosterUrl || !callbackSecret) {
      console.error('[syncRoster] missing config: CLASSROOM_ROSTER_URL or CLASSROOM_CALLBACK_SECRET not set')
      res.status(500).json({ error: 'Classroom roster not configured' })
      return
    }

    try {
      const rosterRes = await fetch(rosterUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${callbackSecret}` },
        body: JSON.stringify({ game_instance_id: gameInstanceId }),
      })
      console.log('[syncRoster] classroom response status:', rosterRes.status)
      if (!rosterRes.ok) {
        const errText = await rosterRes.text().catch(() => '')
        console.error('[syncRoster] classroom error response:', { status: rosterRes.status, body: errText })
        let errMsg: string | undefined
        try { errMsg = (JSON.parse(errText) as Record<string, unknown>).error as string | undefined } catch { /* not JSON */ }
        res.status(502).json({ error: `Classroom roster error: ${errMsg ?? (errText || String(rosterRes.status))}` })
        return
      }

      const { participants } = await rosterRes.json() as {
        participants: Array<{ participant_id: string; name: string; external_id: string | null }>
      }

      if (participants.length === 0) {
        res.json({ ok: true, synced: 0, skipped: 0 })
        return
      }

      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      const participantRefs = participants.map((p) =>
        instanceRef.collection('participants').doc(p.participant_id),
      )

      const snaps = await db.getAll(...participantRefs)

      const batch = db.batch()
      let synced = 0
      let skipped = 0

      for (let i = 0; i < participants.length; i++) {
        const snap = snaps[i]
        const p    = participants[i]
        const existing = snap.data()

        if (existing?.role) {
          // Student has already self-joined with a role — never overwrite
          skipped++
          continue
        }

        if (snap.exists) {
          batch.update(snap.ref, { name: p.name, external_id: p.external_id ?? null })
        } else {
          batch.set(snap.ref, {
            participant_id:   p.participant_id,
            game_instance_id: gameInstanceId,
            name:             p.name,
            external_id:      p.external_id ?? null,
            prep_status:      'not_started',
          })
        }
        synced++
      }

      await instanceRef.set({ game_instance_id: gameInstanceId }, { merge: true })
      if (synced > 0) await batch.commit()

      console.log(`syncRoster: synced=${synced} skipped=${skipped} for instance ${gameInstanceId}`)
      res.json({ ok: true, synced, skipped })
    } catch (err) {
      console.error('[syncRoster] unexpected error:', err instanceof Error ? err.stack : JSON.stringify(err))
      res.status(500).json({ error: 'Internal error' })
    }
  },
)
