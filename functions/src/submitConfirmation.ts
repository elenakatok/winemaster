import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  applyApproval,
  resolveStatus,
  type ApprovalDecision,
  type ApprovalState,
} from '@mygames/game-engine'
import { extractStudentIds } from './engine/studentAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

export const submitConfirmation = onRequest(async (req, res) => {
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

  if (typeof body.confirmed !== 'boolean') {
    res.status(400).json({ error: 'confirmed must be boolean' }); return
  }
  const confirmed = body.confirmed

  try {
    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const pSnap = await instanceRef.collection('participants').doc(participantId).get()
    if (!pSnap.exists) { res.status(404).json({ error: 'Participant not found.' }); return }
    const pdata = pSnap.data()!
    if (!pdata.group_id) { res.status(400).json({ error: 'Not in a group.' }); return }
    if (pdata.is_lead) { res.status(403).json({ error: 'Lead uses submitLeadOutcome.' }); return }

    const groupRef = instanceRef.collection('groups').doc(pdata.group_id as string)

    let txOutcome = 'waiting'

    // All state reads, logic, and writes are inside the transaction — concurrent approvals
    // are serialised by Firestore; no confirmation can be lost.
    await db.runTransaction(async (tx) => {
      const gSnap = await tx.get(groupRef)
      if (!gSnap.exists) throw Object.assign(new Error('Group not found.'), { status: 404 })
      const gdata = gSnap.data()!

      if (gdata.status !== 'reporting') {
        throw Object.assign(
          new Error(`Cannot confirm — group is '${gdata.status as string}'.`),
          { status: 400 },
        )
      }
      // lead_reported_at is the reliable sentinel: it is null on reset and null before first
      // submission, but set to a timestamp whenever the lead has actually submitted (even for null/no-deal).
      if (gdata.lead_reported_at == null) {
        throw Object.assign(new Error('Lead has not reported yet.'), { status: 400 })
      }

      const storedConfs = (gdata.confirmations ?? {}) as Record<string, ApprovalDecision>
      if (storedConfs[participantId] !== 'pending') {
        throw Object.assign(new Error('Already responded this round.'), { status: 400 })
      }

      // Pure reducer: reconstruct state, apply this decision, resolve.
      const state: ApprovalState = { confirmations: storedConfs }
      const newState = applyApproval(state, {
        participantId,
        decision: confirmed ? 'confirmed' : 'rejected',
      })
      const resolution = resolveStatus(newState)

      if (resolution === 'committed') {
        const leadOutcome = gdata.lead_outcome as Record<string, unknown> | null
        tx.update(groupRef, {
          outcome: leadOutcome,
          agreement_reached: leadOutcome !== null,
          status: 'completed',
          completed_at: FieldValue.serverTimestamp(),
          confirmations: newState.confirmations,
        })
        txOutcome = 'locked'
      } else if (resolution === 'reset') {
        const resetCount = ((gdata.reset_count as number | undefined) ?? 0) + 1
        if (resetCount >= 5) {
          tx.update(groupRef, {
            status: 'deadlocked',
            reset_count: resetCount,
            [`confirmations.${participantId}`]: 'rejected',
          })
          txOutcome = 'deadlocked'
        } else {
          // Reset: clear lead submission; set all confirmations back to 'pending'.
          // Group status stays 'reporting' — lead_outcome: null is the re-entry signal.
          const resetConfs: Record<string, ApprovalDecision> = {}
          for (const pid of Object.keys(storedConfs)) resetConfs[pid] = 'pending'
          tx.update(groupRef, {
            reset_count: resetCount,
            lead_outcome: null,
            lead_reported_at: null,
            confirmations: resetConfs,
          })
          txOutcome = 'rejected'
        }
      } else {
        // 'awaiting': one participant confirmed, others still pending.
        // Field-path update only — avoids overwriting concurrent confirmations.
        tx.update(groupRef, { [`confirmations.${participantId}`]: 'confirmed' })
        txOutcome = 'waiting'
      }
    })

    res.json({ ok: true, outcome: txOutcome })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})
