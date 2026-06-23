import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { roleKeys, labelFor, isValidRole, fieldFor } from '@mygames/game-engine'
import { winemasterConfig } from './gameDefinition'
import { extractInstructorGameId } from './engine/instructorAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])
const ROLE_KEYS = roleKeys(winemasterConfig)

/**
 * Returns all participants and group statuses for an instructor's game instance.
 * Merges the roster and group-status reads into one call.
 *
 * Participant display names are read from RTDB attending/<instanceId> (written
 * when participants join via assignRole). Falls back to a participant_id prefix
 * when attending entry is absent (e.g. before the participant flow is built).
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Request body (production): Authorization: Bearer <instructor Firebase id token>
 * Response: { ok, participants, groups }
 */
export const getRoster = onRequest(async (req, res) => {
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

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const [participantsSnap, groupsSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
      admin.database().ref(`attending/${gameInstanceId}`).once('value'),
    ])

    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>

    const participants = participantsSnap.docs.map(doc => {
      const d = doc.data()
      const role = typeof d['role'] === 'string' ? d['role'] : null
      const attendingEntry = attending[doc.id] ?? null
      return {
        participant_id:  doc.id,
        display_name:    attendingEntry?.display_name ?? doc.id.slice(0, 8) + '…',
        role,
        role_label:      role != null && isValidRole(winemasterConfig, role)
                           ? labelFor(winemasterConfig, role)
                           : null,
        group_id:        (d['group_id'] as string | undefined) ?? null,
        is_lead:         (d['is_lead'] as boolean | undefined) ?? null,
        attended:        d['attendance_confirmed_at'] != null,
        finalized:       d['finalized_at'] != null,
      }
    })

    const groups = groupsSnap.docs.map(doc => {
      const g = doc.data()
      return {
        group_id:            g['group_id'] as string,
        status:              g['status'] as string,
        lead_participant_id: g['lead_participant_id'] as string,
        participants_by_role: Object.fromEntries(
          ROLE_KEYS.map(k => [k, (g[fieldFor(k, 'participants')] ?? []) as string[]])
        ),
        agreement_reached:   (g['agreement_reached'] ?? null) as boolean | null,
        outcome:             (g['outcome'] ?? null) as Record<string, unknown> | null,
      }
    })

    res.json({ ok: true, participants, groups })
  } catch (err) {
    console.error('[getRoster] error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
