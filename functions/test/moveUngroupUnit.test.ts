import { describe, it, expect } from 'vitest'
import {
  makeNegotiationGroupAdapter,
  moveOccupant,
  ungroupOccupant,
  checkSeatingInvariants,
  type SeatGroup,
  type SeatOccupant,
  type SeatingPlan,
} from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// Move / Ungroup — PURE-LOGIC invariants for the WINEMASTER (negotiation) adapter.
//
// These are fast, emulator-free checks of the machinery winemaster consumes. Every block
// carries a NEGATIVE CONTROL (07-29 "false green" discipline): the same assertion is shown
// FAILING on a deliberately-broken input, so a green is known to mean something. Expected
// values are derived from a DIFFERENT source than the value under test wherever possible.
// ═══════════════════════════════════════════════════════════════════════════════

const ROLES = ['winemaster', 'home_base'] as const
const adapter = makeNegotiationGroupAdapter(ROLES as unknown as string[])
const CAP = 999 // matches winemaster's NO_SEAT_CAP: no size cap for negotiation.

const occ = (participantId: string, role: string): SeatOccupant => ({ participantId, isBot: false, role })

describe('negotiation adapter — hasStarted / startedField (the per-group lock truth)', () => {
  it('a freshly matched group is NOT started; a negotiating one IS', () => {
    const matched = { status: 'matched', winemaster_participants: ['w1'], home_base_participants: ['h1'] }
    const negotiating = { status: 'negotiating', negotiation_started_at: 123, winemaster_participants: ['w1'], home_base_participants: ['h1'] }
    expect(adapter.startedField).toBe('negotiation_started_at')
    expect(adapter.hasStarted(matched)).toBe(false)
    expect(adapter.hasStarted(negotiating)).toBe(true)
  })

  it('a completed group whose negotiation_started_at is set still reads as started', () => {
    // The realistic post-negotiation state: status has advanced past 'matched' and the
    // timestamp was written at start and never cleared.
    const completed = { status: 'completed', negotiation_started_at: 456 }
    expect(adapter.hasStarted(completed)).toBe(true)
  })

  it('NEGATIVE CONTROL: hasStarted is not constant — it disagrees across the two inputs', () => {
    const matched = { status: 'matched' }
    const negotiating = { status: 'negotiating' }
    // If hasStarted were a stubbed constant, these would be equal — proving the predicate
    // above actually discriminates, not that it happens to return the value we wanted.
    expect(adapter.hasStarted(matched)).not.toBe(adapter.hasStarted(negotiating))
  })
})

describe('move preserves the student role', () => {
  it('a moved winemaster lands in the destination as a winemaster, and the source loses them', () => {
    const source: SeatGroup = { groupId: 'A', started: false, occupants: [occ('w1', 'winemaster'), occ('h1', 'home_base')] }
    const target: SeatGroup = { groupId: 'B', started: false, occupants: [occ('w2', 'winemaster'), occ('h2', 'home_base')] }

    const res = moveOccupant({ participantId: 'w1', source, target, seatCount: CAP })
    expect(res.ok).toBe(true)
    if (!res.ok) return

    // Verify by PARTITIONING through the adapter (a different code path than moveOccupant):
    // writeMembership decides which role-array each occupant goes into, purely from its role.
    const targetPatch = adapter.writeMembership({ existing: null, occupants: res.target!.occupants, lead: null })
    const sourcePatch = adapter.writeMembership({ existing: null, occupants: res.source!.occupants, lead: null })

    // length asserted BEFORE membership checks.
    expect((targetPatch.winemaster_participants as string[]).length).toBe(2)
    expect(targetPatch.winemaster_participants as string[]).toContain('w1')
    expect(sourcePatch.winemaster_participants as string[]).not.toContain('w1')
    // role PRESERVED: w1 is a winemaster in the destination, never demoted into home_base.
    expect(targetPatch.home_base_participants as string[]).not.toContain('w1')
  })

  it('NEGATIVE CONTROL: the assertion would catch a role flip', () => {
    // Fabricate the wrong outcome — w1 written into the home_base array — and confirm the
    // same "role preserved" assertion FAILS on it. A test never seen to fail is not known
    // to work.
    const wrong = adapter.writeMembership({
      existing: null,
      occupants: [{ participantId: 'w1', isBot: false, role: 'home_base' }],
      lead: null,
    })
    expect(() => {
      expect(wrong.home_base_participants as string[]).not.toContain('w1')
    }).toThrow()
  })
})

describe('a STARTED group is frozen for moves IN and OUT', () => {
  const humansA: SeatOccupant[] = [occ('w1', 'winemaster'), occ('h1', 'home_base')]
  const humansB: SeatOccupant[] = [occ('w2', 'winemaster'), occ('h2', 'home_base')]

  it('rejects a move OUT of a started source', () => {
    const source: SeatGroup = { groupId: 'A', started: true, occupants: humansA }
    const target: SeatGroup = { groupId: 'B', started: false, occupants: humansB }
    const res = moveOccupant({ participantId: 'w1', source, target, seatCount: CAP })
    expect(res.ok).toBe(false)
  })

  it('rejects a move INTO a started target', () => {
    const source: SeatGroup = { groupId: 'A', started: false, occupants: humansA }
    const target: SeatGroup = { groupId: 'B', started: true, occupants: humansB }
    const res = moveOccupant({ participantId: 'w1', source, target, seatCount: CAP })
    expect(res.ok).toBe(false)
  })

  it('POSITIVE CONTROL: the SAME move succeeds when neither end has started', () => {
    // Derives the rejection cause from a single toggled variable (`started`), so the two
    // rejections above are attributable to the lock, not to some other precondition.
    const source: SeatGroup = { groupId: 'A', started: false, occupants: humansA }
    const target: SeatGroup = { groupId: 'B', started: false, occupants: humansB }
    const res = moveOccupant({ participantId: 'w1', source, target, seatCount: CAP })
    expect(res.ok).toBe(true)
  })
})

describe('ungroup leaves the group standing with a freed seat', () => {
  it('removes the member from the source; the source still exists with one fewer occupant', () => {
    const source: SeatGroup = { groupId: 'A', started: false, occupants: [occ('w1', 'winemaster'), occ('h1', 'home_base')] }
    const before = source.occupants.length
    const res = ungroupOccupant({ participantId: 'w1', source, seatCount: CAP })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // target is null (nowhere) — that is the No-Group pool; the group stands.
    expect(res.target).toBeNull()
    expect(res.source).not.toBeNull()
    expect(res.source!.occupants.length).toBe(before - 1)
    expect(res.source!.occupants.map(o => o.participantId)).not.toContain('w1')
  })
})

describe('seating invariants — checker HAS TEETH (negative controls)', () => {
  it('a clean plan reports zero violations', () => {
    const plan: SeatingPlan = {
      groups: [
        { groupId: 'A', started: false, occupants: [occ('w1', 'winemaster'), occ('h1', 'home_base')] },
        { groupId: 'B', started: false, occupants: [occ('w2', 'winemaster'), occ('h2', 'home_base')] },
      ],
      unassigned: [occ('w3', 'winemaster')],
    }
    expect(checkSeatingInvariants(plan, CAP)).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: a participant in TWO groups is flagged (never-in-two-groups)', () => {
    const plan: SeatingPlan = {
      groups: [
        { groupId: 'A', started: false, occupants: [occ('w1', 'winemaster')] },
        { groupId: 'B', started: false, occupants: [occ('w1', 'winemaster')] }, // same pid, two groups
      ],
      unassigned: [],
    }
    const violations = checkSeatingInvariants(plan, CAP)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.map(v => v.invariant)).toContain('a participant is never in two groups')
  })

  it('NEGATIVE CONTROL: a participant BOTH grouped and unassigned is flagged (never-lost)', () => {
    const plan: SeatingPlan = {
      groups: [{ groupId: 'A', started: false, occupants: [occ('w1', 'winemaster')] }],
      unassigned: [occ('w1', 'winemaster')], // also in the pool — impossible state
    }
    const violations = checkSeatingInvariants(plan, CAP)
    expect(violations.map(v => v.invariant)).toContain('a participant is never both grouped and unassigned')
  })
})
