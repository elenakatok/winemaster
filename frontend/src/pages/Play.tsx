import { useEffect, useState } from 'react'
import { signInWithCustomToken } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db, functions } from '../firebase'
import { assignRole, CLASSROOM_URL, type CallArgs } from '../api'
import { KnowledgeCheck } from '@mygames/game-ui'

type Phase = 'loading' | 'error' | 'kc' | 'prep' | 'done'

type Session = {
  participantId:   string
  gameInstanceId:  string
  role:            string
}

/**
 * Student play entry point.
 *
 * Production URL: /?token=<classroom JWT>
 * Emulator dev URL: /?_pid=<participant_id>&_gid=<game_instance_id>
 *   (DEV only — the _test params bypass JWT verification in Cloud Functions)
 */
export default function Play() {
  const [phase,    setPhase]    = useState<Phase>('loading')
  const [session,  setSession]  = useState<Session | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    const p      = new URLSearchParams(window.location.search)
    const token  = p.get('token')
    const testPid = import.meta.env.DEV ? p.get('_pid') : null
    const testGid = import.meta.env.DEV ? p.get('_gid') : null

    if (!token && !(testPid && testGid)) {
      // No entry params — placeholder until classroom integration
      setPhase('done')
      return
    }

    const args: CallArgs = (testPid && testGid)
      ? { _test: { participant_id: testPid, game_instance_id: testGid } }
      : { token: token! }

    const bootstrap = async () => {
      try {
        // 1. Assign role and receive a short-lived custom token
        const result = await assignRole(args)

        // 2. Sign in — SDK will now attach Bearer on all subsequent calls
        await signInWithCustomToken(auth, result.customToken)

        const sess: Session = {
          participantId:  result.participant_id,
          gameInstanceId: result.game_instance_id,
          role:           result.role,
        }
        setSession(sess)

        // 3. Read participant doc to route to the correct phase on resume
        const snap = await getDoc(
          doc(db, 'game_instances', sess.gameInstanceId, 'participants', sess.participantId),
        )
        const pdata = snap.data() ?? {}

        if (pdata.prep_status === 'complete') {
          setPhase('done')
        } else if (pdata.knowledge_check_score != null) {
          setPhase('prep')
        } else {
          setPhase('kc')
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to start session.')
        setPhase('error')
      }
    }

    void bootstrap()
  }, [])

  if (phase === 'loading') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (phase === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#c00' }}>{errorMsg ?? 'Something went wrong.'}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase === 'kc' && session) {
    return (
      <KnowledgeCheck
        participantId={session.participantId}
        gameInstanceId={session.gameInstanceId}
        functions={functions}
        db={db}
        onComplete={() => setPhase('prep')}
      />
    )
  }

  if (phase === 'prep') {
    // Prep-questions component mounts here in a future slice.
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif', maxWidth: '640px', margin: '0 auto' }}>
        <p style={{ color: '#555' }}>Prep questions</p>
        <p>Prep questions will appear here.</p>
      </main>
    )
  }

  // phase === 'done' (waiting for match) or no entry params yet
  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', textAlign: 'center' }}>
      <h1>Winemaster</h1>
      <p>Coming soon.</p>
    </div>
  )
}
