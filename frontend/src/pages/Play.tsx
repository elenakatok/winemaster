import { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from '../firebase'
import { assignRole, CLASSROOM_URL } from '../api'
import { useStudentSession, KnowledgeCheck, InfoPage, PrepQuestions } from '@mygames/game-ui'
import type { BootstrapArgs, InfoPageLink } from '@mygames/game-ui'

// ── Phase state ───────────────────────────────────────────────────────────────
// 'loading' = routing in progress after session is ready.

type GamePhase =
  | { name: 'loading' }
  | { name: 'error';  message: string }
  | { name: 'info';   roleLabel: string; links: InfoPageLink[]; publicLink: { label: string; url: string } | null }
  | { name: 'kc' }           // KC component (KC-3)
  | { name: 'prep' }         // BU-2c: prep questions
  | { name: 'done' }         // waiting for match / post-game

// ── Phase routing ─────────────────────────────────────────────────────────────

type GetInfoUrlsResult = {
  ok: boolean
  roleLabel: string
  links: InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

async function routeToPhase(participantId: string, gameInstanceId: string): Promise<GamePhase> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = snap.data() ?? {}
  if (d.prep_status === 'complete')    return { name: 'done' }
  if (d.knowledge_check_score != null) return { name: 'prep' }

  // Fresh participant → info page. Cloud function returns only this role's URLs.
  const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
  const { data } = await fn({})
  return {
    name: 'info',
    roleLabel:  data.roleLabel,
    links:      data.links,
    publicLink: data.publicLink ?? null,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Play() {
  const p        = new URLSearchParams(window.location.search)
  const token    = p.get('token')
  const testPid  = import.meta.env.DEV ? p.get('_pid') : null
  const testGid  = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase] = useState<GamePhase>({ name: 'loading' })

  // ── Session lifecycle (shared machinery) ──────────────────────────────────
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

  // ── Phase routing ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (session.kind !== 'ready') return
    const { participantId, gameInstanceId } = session
    let cancelled = false
    routeToPhase(participantId, gameInstanceId)
      .then(p  => { if (!cancelled) setPhase(p) })
      .catch(err => { if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' }) })
    return () => { cancelled = true }
  }, [session])

  // ── Render ─────────────────────────────────────────────────────────────────

  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p>Loading…</p>
      </main>
    )
  }

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

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  // ── session.kind === 'ready', phase is active ──────────────────────────────

  if (phase.name === 'info') {
    return (
      <InfoPage
        roleLabel={phase.roleLabel}
        links={phase.links}
        publicLink={phase.publicLink}
        onContinue={() => setPhase({ name: 'kc' })}
      />
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
    return (
      <PrepQuestions
        participantId={session.participantId}
        gameInstanceId={session.gameInstanceId}
        functions={functions}
        db={db}
        onComplete={() => setPhase({ name: 'done' })}
      />
    )
  }

  // phase === 'done'
  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', textAlign: 'center' }}>
      <h1>Winemaster</h1>
      <p>Coming soon.</p>
    </div>
  )
}
