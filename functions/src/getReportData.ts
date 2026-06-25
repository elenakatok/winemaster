import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import type { Outcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '@mygames/game-server'
import { computeScoreBreakdown, winemasterGameDef } from './gameDefinition'

const VALID_ROLES = new Set(['winemaster', 'home_base'])

export type ReportRow = {
  participant_id: string
  display_name: string
  group_number: number | null
  role: string
  shares: number | null
  vesting: string | null
  board_seat: boolean | null
  liability: number | null
  value_or_cost: number | null
  raw_score: number | null
}

export const getReportData = onCall({ cors: winemasterGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined

  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  try {
    const db = admin.firestore()
    const rtdb = admin.database()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)

    const [participantsSnap, groupsSnap, configSnap, attendingSnap] = await Promise.all([
      instanceRef.collection('participants').get(),
      instanceRef.collection('groups').get(),
      instanceRef.collection('config').doc('main').get(),
      rtdb.ref(`game_instances/${gameInstanceId}/attendance`).get(),
    ])

    const configData = (configSnap.data() ?? {}) as Record<string, unknown>

    // RTDB attending map: uid → { display_name? }
    const attending = (attendingSnap.val() ?? {}) as Record<string, { display_name?: string } | null>

    // Assign stable group numbers by sorted group_id.
    const sortedGroups = groupsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))
    const groupNumberMap = new Map<string, number>(sortedGroups.map((g, i) => [g.id, i + 1]))
    const groupOutcomeMap = new Map<string, Outcome | null>(
      sortedGroups.map(g => [g.id, (g.data()['outcome'] as Outcome | null) ?? null])
    )

    const rows: ReportRow[] = []

    for (const pdoc of participantsSnap.docs) {
      const d = pdoc.data() as Record<string, unknown>

      // Only include finalized, role-bearing participants who were scored (raw_score !== null).
      if (d['finalized_at'] == null) continue
      const role = d['role'] as string | undefined
      if (!role || !VALID_ROLES.has(role)) continue
      if (d['raw_score'] === null || d['raw_score'] === undefined) continue

      const groupId = d['group_id'] as string | undefined

      // Resolve display name: RTDB overlay first, then Firestore fields, then id prefix.
      const rtdbName = attending[pdoc.id]?.display_name?.trim()
      const fsName   = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
      const display_name = rtdbName || fsName || `${pdoc.id.slice(0, 8)}…`

      const outcome = groupId ? (groupOutcomeMap.get(groupId) ?? null) : null

      // value_or_cost: use stored field (written by makeFinalizeInstance v0.7.4+)
      // or compute on-the-fly for instances finalized before v0.7.4.
      let value_or_cost: number | null = null
      if (typeof d['value_or_cost'] === 'number') {
        value_or_cost = d['value_or_cost']
      } else {
        const breakdown = computeScoreBreakdown(role, outcome, configData)
        value_or_cost = breakdown.value_or_cost
      }

      rows.push({
        participant_id: pdoc.id,
        display_name,
        group_number: groupId ? (groupNumberMap.get(groupId) ?? null) : null,
        role,
        shares:     outcome ? (outcome['shares']     as number)  : null,
        vesting:    outcome ? (outcome['vesting']    as string)  : null,
        board_seat: outcome ? (outcome['board_seat'] as boolean) : null,
        liability:  outcome ? (outcome['liability']  as number)  : null,
        value_or_cost,
        raw_score: d['raw_score'] as number,
      })
    }

    // Sort by group number then display name for a predictable default order.
    rows.sort((a, b) => {
      const gn = (a.group_number ?? Infinity) - (b.group_number ?? Infinity)
      if (gn !== 0) return gn
      return a.display_name.localeCompare(b.display_name)
    })

    return { ok: true as const, rows }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getReportData] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
