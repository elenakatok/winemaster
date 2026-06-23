import { randomUUID } from 'crypto'
import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { matchParticipants, roleKeys, isValidRole, fieldFor } from '@mygames/game-engine'
import { winemasterConfig } from './gameDefinition'
import { extractInstructorGameId } from './engine/instructorAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])
const COMPOSITION: Record<string, number> = { winemaster: 2, home_base: 2 }
const ROLE_KEYS = roleKeys(winemasterConfig)

export const triggerMatching = onRequest(async (req, res) => {
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

    // Idempotency: return existing groups if matching already ran.
    const existingSnap = await instanceRef.collection('groups').limit(1).get()
    if (!existingSnap.empty) {
      const allSnap = await instanceRef.collection('groups').get()
      const groups = allSnap.docs.map(d => {
        const data = d.data()
        return {
          group_id: data.group_id as string,
          game_instance_id: data.game_instance_id as string,
          lead_participant_id: data.lead_participant_id as string,
          outcome: data.outcome as null,
          status: data.status as string,
          ...Object.fromEntries(
            ROLE_KEYS.map(k => [fieldFor(k, 'participants'), data[fieldFor(k, 'participants')] as string[]])
          ),
        }
      })
      res.json({ ok: true, groups, alreadyMatched: true })
      return
    }

    // Read RTDB presence and all participant docs in parallel.
    const [presenceSnap, participantsSnap] = await Promise.all([
      admin.database().ref(`presence/${gameInstanceId}`).once('value'),
      instanceRef.collection('participants').get(),
    ])
    const presentIds = new Set<string>(Object.keys(presenceSnap.val() ?? {}))

    // Eligible: attended + valid role + present in RTDB.
    const eligible = participantsSnap.docs
      .filter(doc => {
        const d = doc.data()
        return (
          d.attendance_confirmed_at != null &&
          isValidRole(winemasterConfig, d.role as string) &&
          presentIds.has(doc.id)
        )
      })
      .map(doc => ({ participant_id: doc.id, role: doc.data().role as string }))

    // Guard: need at least 2 of each role to form one base group.
    const baseGroupCount = Math.min(
      ...ROLE_KEYS.map(k =>
        Math.floor(eligible.filter(p => p.role === k).length / (COMPOSITION[k] ?? 1))
      )
    )
    if (baseGroupCount === 0) {
      res.status(400).json({
        ok: false,
        error: 'Not enough participants to form a group (need ≥ 2 of each role present).',
      })
      return
    }

    // perRoleCap = eligible.length ensures every extra participant is placed
    // (no group ever fills up, so the library's distributeExtras break never fires).
    const rawGroups = matchParticipants(eligible, {
      roleConfig: winemasterConfig,
      composition: COMPOSITION,
      perRoleCap: eligible.length,
    })

    // Batch: set group docs + stamp each participant with group_id and is_lead.
    const batch = db.batch()
    const groups = rawGroups.map(g => {
      const groupId = randomUUID()
      const groupRef = instanceRef.collection('groups').doc(groupId)
      const roleFields = Object.fromEntries(
        ROLE_KEYS.map(k => [fieldFor(k, 'participants'), g[fieldFor(k, 'participants')] as string[]])
      )
      batch.set(groupRef, {
        group_id: groupId,
        game_instance_id: gameInstanceId,
        lead_participant_id: g.lead_participant_id,
        outcome: null,
        ...roleFields,
        status: 'matched',
        matched_at: FieldValue.serverTimestamp(),
      })
      for (const key of ROLE_KEYS) {
        for (const pid of g[fieldFor(key, 'participants')] as string[]) {
          batch.update(instanceRef.collection('participants').doc(pid), {
            group_id: groupId,
            is_lead: pid === g.lead_participant_id,
          })
        }
      }
      return {
        group_id: groupId,
        game_instance_id: gameInstanceId,
        lead_participant_id: g.lead_participant_id,
        outcome: null as null,
        status: 'matched',
        ...roleFields,
      }
    })

    await batch.commit()
    res.json({ ok: true, groups })
  } catch (err) {
    console.error('triggerMatching error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
