import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, functions } from '../firebase'
import { assignRole, CLASSROOM_URL } from '../api'
import { useStudentSession, KnowledgeCheck } from '@mygames/game-ui'
import type { BootstrapArgs } from '@mygames/game-ui'

// ── Phase state ───────────────────────────────────────────────────────────────
// 'loading' = routing in progress after session is ready.
// Actual phase screens are wired in BU-2b / BU-2c; stubs stand in for now.

type GamePhase =
  | { name: 'loading' }
  | { name: 'error';  message: string }
  | { name: 'info' }         // BU-2b: role-info PDF page
  | { name: 'kc' }           // KC component (KC-3)
  | { name: 'prep' }         // BU-2c: prep questions
  | { name: 'done' }         // waiting for match / post-game

// ── Phase routing ─────────────────────────────────────────────────────────────

async function routeToPhase(participantId: string, gameInstanceId: string): Promise<GamePhase> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = snap.data() ?? {}
  if (d.prep_status === 'complete')          return { name: 'done' }
  if (d.knowledge_check_score != null)       return { name: 'prep' }
  return { name: 'kc' }
  // TODO BU-2b: add 'info' slot (between role assignment and kc) once info phase is built.
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Student play entry point for Winemaster.
 *
 * Production URL:   /?token=<classroom JWT>
 * Emulator dev URL: /?_pid=<participant_id>&_gid=<game_instance_id>
 *   (DEV only — _test params bypass JWT verification in Cloud Functions)
 */
export default function Play() {
  const p        = new URLSearchParams(window.location.search)
  const token    = p.get('token')
  const testPid  = import.meta.env.DEV ? p.get('_pid') : null
  const testGid  = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase] = useState<GamePhase>({ name: 'loading' })

  // ── Session lifecycle (shared machinery) ─────────────────────────────────────
  // useStudentSession owns: authStateReady resume guard, once-only JWT exchange,
  // signInWithCustomToken, persistence mode selection.
  // Winemaster injects only its bootstrap (assignRole via httpsCallable).
  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await assignRole(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  // ── Phase routing ─────────────────────────────────────────────────────────────
  // Fires once when the session transitions to 'ready' (fresh entry or resume).
  // After this point all backend calls use the auto-refreshing Firebase ID token.
  useEffect(() => {
    if (session.kind !== 'ready') return
    // session is stable after transitioning to 'ready'; deps cover the transition.
    const { participantId, gameInstanceId } = session
    let cancelled = false
    routeToPhase(participantId, gameInstanceId)
      .then(p  => { if (!cancelled) setPhase(p) })
      .catch(err => { if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' }) })
    return () => { cancelled = true }
  }, [session]) // session ref changes once: loading → ready/error/no-token

  // ── Render ────────────────────────────────────────────────────────────────────

  // Show loading while session is establishing OR while routing is in progress.
  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p>Loading…</p>
      </main>
    )
  }

  // No launch token — student must enter from the classroom.
  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Winemaster</h2>
        <p>Please launch Winemaster from the classroom to join a session.</p>
        <p style={{ marginTop: '1.5rem' }}>
          <a href={CLASSROOM_URL}>← Go to classroom</a>
        </p>
      </main>
    )
  }

  // Session error (bootstrap failed, token expired, etc.)
  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  // Phase error (Firestore read failed after session established)
  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  // ── session.kind === 'ready', phase is active ─────────────────────────────────

  if (phase.name === 'info') {
    // BU-2b: Phase1Info component (role-info PDF page) mounts here.
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '640px', margin: '0 auto' }}>
        <p style={{ color: '#555' }}>Role info page — coming in BU-2b.</p>
      </main>
    )
  }

  if (phase.name === 'kc') {
    return (
      <KnowledgeCheck
        participantId={session.participantId}
        gameInstanceId={session.gameInstanceId}
        functions={functions}
        db={db}
        onComplete={() => setPhase({ name: 'prep' })}
      />
    )
  }

  if (phase.name === 'prep') {
    // BU-2c: Phase1PrepQuestions component mounts here.
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '640px', margin: '0 auto' }}>
        <p style={{ color: '#555' }}>Prep questions — coming in BU-2c.</p>
        <p>Prep questions will appear here.</p>
      </main>
    )
  }

  // phase === 'done' (prep complete; waiting for match or post-game)
  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', textAlign: 'center' }}>
      <h1>Winemaster</h1>
      <p>Coming soon.</p>
    </div>
  )
}
