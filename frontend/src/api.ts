import { auth } from './firebase'

const FUNCTIONS_BASE = import.meta.env.DEV
  ? 'http://127.0.0.1:5005/winemaster-mygames-live/us-central1'
  : 'https://us-central1-winemaster-mygames-live.cloudfunctions.net'

export type TestArgs  = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs = { token: string }
export type CallArgs  = TestArgs | TokenArgs

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

export function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.message.includes('(401)') || err.message.includes('(403)')
}

async function callFunction<T>(name: string, body: object): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${data.error ?? name + ' failed'} (${res.status})`)
  return data
}

export async function callFunctionWithSession<T>(name: string, body: object): Promise<T> {
  const user = auth.currentUser
  if (!user) throw new Error('No active session')
  const idToken = await user.getIdToken()
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(`${data.error ?? name + ' failed'} (${res.status})`)
  return data
}

export type OutcomeFields = Record<string, unknown>

export const submitLeadOutcome = (args: CallArgs, outcome: OutcomeFields | null) =>
  callFunction<{ ok: boolean }>('submitLeadOutcome', { ...args, outcome })

export const submitConfirmation = (args: CallArgs, confirmed: boolean) =>
  callFunction<{ ok: boolean; outcome: string }>('submitConfirmation', { ...args, confirmed })

// ── Instructor API ────────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export type RosterParticipant = {
  participant_id: string
  display_name:   string
  role:           string | null
  role_label:     string | null
  group_id:       string | null
  is_lead:        boolean | null
  attended:       boolean
  finalized:      boolean
}

export type RosterGroup = {
  group_id:             string
  status:               string
  lead_participant_id:  string
  participants_by_role: Record<string, string[]>
  agreement_reached:    boolean | null
  outcome:              Record<string, unknown> | null
}

export type PushSummary = {
  total:     number
  succeeded: number
  failed:    { participant_id: string; reason: string }[]
}

/** Bootstrap call — no session established yet; returns a Firebase custom token. */
export const getInstructorSession = (args: InstructorSessionArgs) =>
  callFunction<{ ok: boolean; customToken: string }>('getInstructorSession', args)

/** All remaining instructor calls are gated on the Firebase Bearer session. */
export const getRoster = () =>
  callFunctionWithSession<{ ok: boolean; participants: RosterParticipant[]; groups: RosterGroup[] }>('getRoster', {})

export const triggerMatching = () =>
  callFunctionWithSession<{ ok: boolean; groups: unknown[]; alreadyMatched?: boolean }>('triggerMatching', {})

export const finalizeInstance = () =>
  callFunctionWithSession<{ ok: boolean }>('finalizeInstance', {})

export const pushResultsToClassroom = () =>
  callFunctionWithSession<{ ok: boolean } & PushSummary>('pushResultsToClassroom', {})
