// ═══════════════════════════════════════════════════════════════════════════════
// WINEMASTER — instructor move / ungroup (CLASSROOM MODE).
//
// Instructor_Move_Ungroup_Shared_Spec_v3, Phase 1 + Phase 3.1 (winemaster first).
// winemaster is the FIRST consumer of makeNegotiationGroupAdapter (the audit noted it
// was "DEFINED, no consumer until the six-game rollout"). We consume the EXISTING shared
// factory `makeMoveSeat` — no shared game-server source is changed here; this file only
// builds the negotiation OnlineContext and exports the one callable the panel needs.
//
// SCOPE: classroom move/ungroup only. The online-mode grouping callables
// (groupParticipantsOnline / getOnlineGroups / startAllGroups / recordLogin) are
// deliberately NOT wired — online is a later, Grays-only task.
// ═══════════════════════════════════════════════════════════════════════════════

import { HttpsError } from 'firebase-functions/v2/https'
import { roleKeys } from '@mygames/game-engine'
import {
  makeMoveSeat,
  makeNegotiationGroupAdapter,
  type OnlineContext,
  type OnlineDefinition,
} from '@mygames/game-server'
import { winemasterGameDef } from './gameDefinition'

/**
 * NO SIZE CAP (spec §2). "Lopsided groups are legal … a student may move into ANY
 * not-started group" — the same decision as the latecomer spec's no-size-caps. The pure
 * seat op (moveOccupant) needs a finite seatCount to test fullness, so this sentinel sits
 * far above any real 2v2 negotiation group: a manual move never bounces on size. It is NOT
 * a real capacity, and because negotiation groups hold no bots, the bot-eviction path that
 * seatCount also guards can never fire here.
 */
const NO_SEAT_CAP = 999

const onlineDef: OnlineDefinition = {
  seatCount: NO_SEAT_CAP,
  // Negotiation is human-vs-human — bots never exist (spec §2 / §6). makeMoveSeat never
  // calls this (only topUpGroupWithBots does, which winemaster does not export); it is
  // present because OnlineDefinition requires it, and throws so an accidental future wiring
  // of bot-fill fails loudly rather than minting a phantom seat.
  makeBotSeat: () => {
    throw new HttpsError('failed-precondition', 'Winemaster is a negotiation game — bots are never used.')
  },
}

const ctx: OnlineContext = {
  def: winemasterGameDef,
  online: onlineDef,
  adapter: makeNegotiationGroupAdapter(roleKeys(winemasterGameDef.roles)),
}

/**
 * Instructor move / ungroup / place-into-new-group — ONE callable, three behaviours keyed
 * by `target_group_id`:  ''  ungroup (seat frees, group stands),  'new'  create a group,
 * else a group id → move into it. Args: { participant_id, target_group_id }.
 *
 * The per-group lock is REAL and enforced server-side: the negotiation adapter's
 * hasStarted (negotiation_started_at set OR status 'negotiating') freezes a started group
 * for moves IN and OUT, while not-started siblings stay movable. The student keeps their
 * role — the pure seat op carries each occupant's role and the adapter writes it back into
 * that role's `<role>_participants` array.
 */
export const moveSeat = makeMoveSeat(ctx)
