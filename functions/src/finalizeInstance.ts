import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { computeZScoresByRole, type ScoringRecord, type Outcome } from '@mygames/game-engine'
import { winemasterConfig, winemasterScoreSense, computeRawScore } from './gameDefinition'
import { extractInstructorGameId } from './engine/instructorAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

export const finalizeInstance = onRequest(async (req, res) => {
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

    // 1. Read all groups; guard: every group must be status:'completed'.
    //    Deadlocked or still-active groups are not finalization-ready.
    const groupsSnap = await instanceRef.collection('groups').get()
    for (const gdoc of groupsSnap.docs) {
      if (gdoc.data()['status'] !== 'completed') {
        res.status(400).json({
          ok: false,
          error: `Group ${gdoc.id} is not resolved — resolve all groups before finalizing`,
        })
        return
      }
    }

    // Build group lookup: group_id → { outcome, agreement_reached }.
    const groupMap = new Map<string, { outcome: Outcome | null; agreement_reached: boolean }>()
    for (const gdoc of groupsSnap.docs) {
      const d = gdoc.data()
      groupMap.set(gdoc.id, {
        outcome: (d['outcome'] as Outcome | null) ?? null,
        agreement_reached: Boolean(d['agreement_reached']),
      })
    }

    // 2. Read all participants.
    const participantsSnap = await instanceRef.collection('participants').get()

    // 3. Classify each participant and build ScoringRecord[].
    const records: ScoringRecord[] = participantsSnap.docs.map(pdoc => {
      const p    = pdoc.data()
      const role = p['role'] as string
      const gid  = p['group_id'] as string | undefined

      if (!gid) {
        // No group_id → no-show (never matched).
        return { participant_id: pdoc.id, role, status: 'no_show', agreement_reached: false, outcome: null, knowledge_check_score: null }
      }

      const group = groupMap.get(gid)
      if (!group) {
        // group_id set but no group doc — data integrity guard; treat as no-show.
        return { participant_id: pdoc.id, role, status: 'no_show', agreement_reached: false, outcome: null, knowledge_check_score: null }
      }

      // group_id + completed group → status:'completed'.
      // This covers both deals (agreement_reached=true, outcome set) and walk-aways
      // (agreement_reached=false, outcome=null). Walk-aways stay in the scored pool;
      // computeZScoresByRole calls computeRawScore(role, null) for them.
      return {
        participant_id:       pdoc.id,
        role,
        status:               'completed',
        agreement_reached:    group.agreement_reached,
        outcome:              group.outcome,
        knowledge_check_score: null,
      }
    })

    // 4. Normalize. The library handles per-role pools, sample SD (÷N−1), cost-sense negation,
    //    no_show exclusion (→ normalized=−2), and walk-away pool inclusion.
    const finalized = computeZScoresByRole(records, winemasterConfig, winemasterScoreSense, computeRawScore)

    // 5. Write scores and finalized_at for every participant in a single batch.
    const now = FieldValue.serverTimestamp()
    const batch = db.batch()
    for (const f of finalized) {
      batch.update(instanceRef.collection('participants').doc(f.participant_id), {
        raw_score:             f.raw_score,
        normalized_score:      f.normalized_score,
        knowledge_check_score: f.knowledge_check_score,
        finalized_at:          now,
      })
    }
    await batch.commit()

    res.json({ ok: true, scored: finalized.length })
  } catch (err) {
    console.error('finalizeInstance error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})
