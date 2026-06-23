import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { validateOutcome, initialApprovalState, roleKeys, fieldFor } from '@mygames/game-engine'
import { winemasterConfig, winemasterSchema } from './gameDefinition'
import { extractStudentIds } from './engine/studentAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])
const ROLE_KEYS = roleKeys(winemasterConfig)

export const submitLeadOutcome = onRequest(async (req, res) => {
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

  // Require outcome key; null = no deal.
  if (!('outcome' in body)) {
    res.status(400).json({ error: 'outcome is required (use null for no deal)' }); return
  }
  const rawOutcome = body.outcome

  if (rawOutcome !== null) {
    if (typeof rawOutcome !== 'object' || Array.isArray(rawOutcome)) {
      res.status(400).json({ error: 'outcome must be an object or null' }); return
    }
    const validation = validateOutcome(winemasterSchema, rawOutcome as Record<string, unknown>)
    if (!validation.valid) {
      res.status(400).json({ ok: false, error: 'Invalid outcome', details: validation.errors }); return
    }
  }
  const leadOutcome = rawOutcome as Record<string, unknown> | null

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const pSnap = await instanceRef.collection('participants').doc(participantId).get()
    if (!pSnap.exists) { res.status(404).json({ error: 'Participant not found.' }); return }
    const pdata = pSnap.data()!
    if (!pdata.group_id) { res.status(400).json({ error: 'Not in a group.' }); return }
    if (!pdata.is_lead) { res.status(403).json({ error: 'Only the lead can report the outcome.' }); return }

    const groupRef = instanceRef.collection('groups').doc(pdata.group_id as string)
    const gSnap = await groupRef.get()
    if (!gSnap.exists) { res.status(404).json({ error: 'Group not found.' }); return }
    const gdata = gSnap.data()!

    if (gdata.status === 'completed') {
      res.status(400).json({ error: 'Outcome already locked.' }); return
    }
    if (gdata.status === 'deadlocked') {
      res.status(400).json({ error: 'Group is deadlocked — awaiting instructor.' }); return
    }
    // Use lead_reported_at (not lead_outcome) as the sentinel — handles the no-deal case where
    // lead_outcome is null both on reset and on a valid no-deal submission.
    if (gdata.status === 'reporting' && gdata.lead_reported_at != null) {
      res.status(400).json({ error: 'Already submitted this round. Waiting for group to review.' }); return
    }

    // Collect all non-lead pids using role-driven field access — no hardcoded role names.
    const allPids: string[] = []
    for (const key of ROLE_KEYS) {
      const pids = gdata[fieldFor(key, 'participants')] as string[] | undefined
      if (pids) allPids.push(...pids)
    }
    const nonLeadIds = allPids.filter(pid => pid !== (gdata.lead_participant_id as string))
    const { confirmations } = initialApprovalState(nonLeadIds)

    await groupRef.update({
      status: 'reporting',
      lead_outcome: leadOutcome,
      lead_reported_at: FieldValue.serverTimestamp(),
      confirmations,
    })
    res.json({ ok: true })
  } catch (err) {
    console.error('submitLeadOutcome error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
