import { useCallback, useEffect, useRef, useState } from 'react'
import { httpsCallable, type Functions } from 'firebase/functions'
import { onAuthStateChanged, type Auth } from 'firebase/auth'
import {
  GroupsPanel,
  MoveMemberControl,
  type GroupsPanelRow,
  type GroupsPanelDestination,
  type SharedParticipant,
  type SharedGroup,
} from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// WINEMASTER — instructor Groups panel (move / ungroup), CLASSROOM MODE.
//
// Mounted into the shared dashboard's `underHeadline` slot (the same way infoshare mounts
// its own control strip), so it lives ENTIRELY in winemaster — the shared game-ui
// dashboard is not modified, and the other five games (which do not mount this) are
// untouched.
//
// ⚠ NAME OVERLAY (audit cross-cutting finding / spec v3 §"NAME-OVERLAY RECONCILIATION").
// The panel is fed from `getRoster`, whose participants already carry display_name with the
// RTDB `attending` overlay applied server-side (makeGetRoster). So names in this panel match
// the roster table by construction — we do NOT use getOnlineGroups, whose names are the bare
// participant-doc names and would disagree with the roster.
// ═══════════════════════════════════════════════════════════════════════════════

const POLL_MS = 5000

type RosterResult = {
  ok: boolean
  participants: SharedParticipant[]
  groups: SharedGroup[]
}

/**
 * A negotiation group is movable only while freshly matched. Once it starts negotiating the
 * status advances past 'matched' (server truth: negotiation_started_at is set), and the group
 * is frozen for moves IN and OUT — the per-group lock. This mirrors the server adapter's
 * hasStarted and negotiationIsJoinable (both keyed on status === 'matched').
 *
 * FAMILY DEFAULT. Baxter (multi-round; negotiation_started_at is re-stamped and never cleared)
 * needs a round-aware check and is explicitly out of scope for this task.
 */
const isStarted = (g: SharedGroup) => g.status !== 'matched'

const STATUS_LABEL: Record<string, string> = {
  matched:     'Matched — not started',
  negotiating: 'Negotiating',
  reporting:   'Reporting',
  completed:   'Completed',
  deadlocked:  'Deadlocked',
}

export function GroupsControlStrip({
  functions,
  auth,
  roleLabels,
}: {
  functions: Functions
  auth: Auth
  roleLabels: Record<string, string>
}) {
  const [participants, setParticipants] = useState<SharedParticipant[]>([])
  const [groups, setGroups] = useState<SharedGroup[]>([])
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Auth-readiness gate ──────────────────────────────────────────────────────
  // getRoster is instructor-authenticated: the Firebase SDK only attaches the Bearer token
  // once the instructor session is signed in. Polling before that sends a tokenless request,
  // which the server correctly rejects with 400 "Missing token". So wait for auth exactly as
  // the shared dashboard gates its own poll (on the same session becoming ready). Gating on
  // `auth.currentUser` (via onAuthStateChanged) keeps this PORTABLE — it depends only on the
  // passed Auth instance, so the gate travels with the panel when it is reused in other games.
  const [ready, setReady] = useState(() => auth.currentUser != null)
  useEffect(() => onAuthStateChanged(auth, user => setReady(user != null)), [auth])

  const load = useCallback(() => {
    const fn = httpsCallable<object, RosterResult>(functions, 'getRoster')
    fn({})
      .then(r => { setParticipants(r.data.participants); setGroups(r.data.groups); setError(null) })
      // The instructor session may not be established on the very first tick; the interval
      // retries. A real move error is surfaced separately (see `move`).
      .catch(() => {})
  }, [functions])

  useEffect(() => {
    if (!ready) return // don't poll until the instructor session exists — no tokenless getRoster calls
    load()
    timer.current = setInterval(load, POLL_MS)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [ready, load])

  // move / ungroup / new-group — one callable, target_group_id carries the intent:
  //   '' → ungroup,  'new' → new group,  else → a group id. (moveSeat's own contract.)
  const move = useCallback(async (participantId: string, destination: string) => {
    const fn = httpsCallable(functions, 'moveSeat')
    try {
      await fn({ participant_id: participantId, target_group_id: destination })
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Move failed.')
    }
  }, [functions, load])

  // Nothing to manage until matching has produced groups (before that, everyone is
  // ungrouped and that is not the stranded case — GroupsPanel makes the same choice).
  if (groups.length === 0) return null

  // Stable 1-based numbers by sorted group id — the SAME ordering the server (groupNumbering)
  // and the dashboard use, so a group's number is identical on every screen.
  const sorted = [...groups].sort((a, b) => a.group_id.localeCompare(b.group_id))
  const numberById = new Map(sorted.map((g, i) => [g.group_id, i + 1]))
  const nameById = new Map(participants.map(p => [p.participant_id, p.display_name]))
  const roleKeys = Object.keys(roleLabels)

  // Every NOT-STARTED group is a legal destination — no size cap (spec §2). A started group
  // is never a destination (the server refuses it, and it renders 🔒 instead of controls).
  const openGroups = sorted.filter(g => !isStarted(g))
  const destinationsExcept = (groupId: string): GroupsPanelDestination[] =>
    openGroups
      .filter(g => g.group_id !== groupId)
      .map(g => ({ id: g.group_id, number: numberById.get(g.group_id) ?? null }))

  const humansOf = (g: SharedGroup) =>
    roleKeys.flatMap(k =>
      (g.participants_by_role[k] ?? []).map(pid => ({
        participantId: pid,
        name: nameById.get(pid) ?? pid.slice(0, 8) + '…',
      })),
    )

  const rows: GroupsPanelRow[] = sorted.map(g => {
    const number = numberById.get(g.group_id) ?? null
    const started = isStarted(g)
    return {
      key: g.group_id,
      number,
      status: STATUS_LABEL[g.status] ?? g.status,
      live: g.status === 'negotiating',
      // A started group renders "🔒 locked" INSTEAD of the move control (GroupsPanel rule) —
      // the per-group lock, reflecting the same server truth that refuses the move.
      locked: started,
      actions: started ? undefined : (
        <MoveMemberControl
          groupNumber={number}
          members={humansOf(g)}
          destinations={destinationsExcept(g.group_id)}
          onMove={move}
          testId={`wm-move-${number}`}
        />
      ),
    }
  })

  // The No-Group pool: anyone with no group_id (ungrouped, dropped, or a no-show). Placing
  // them uses the same move callable. Ungroup is always reachable from a group's own control
  // even when the pool is the only place to land.
  const noGroup = participants
    .filter(p => p.group_id == null)
    .map(p => ({ participantId: p.participant_id, name: p.display_name }))

  const poolDestinations: GroupsPanelDestination[] = openGroups.map(g => ({
    id: g.group_id,
    number: numberById.get(g.group_id) ?? null,
  }))

  return (
    <GroupsPanel
      testId="wm-groups"
      heading="Groups"
      rows={rows}
      noGroup={noGroup}
      destinations={poolDestinations}
      onPlace={move}
      footer={error ? <span style={{ color: '#c00', fontSize: '0.8rem' }}>{error}</span> : undefined}
    />
  )
}
