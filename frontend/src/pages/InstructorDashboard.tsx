import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth } from '../firebase'
import {
  getInstructorSession,
  syncRoster,
  generateAttendanceCode,
  getRoster,
  triggerMatching,
  finalizeInstance,
  pushResultsToClassroom,
  isAuthError,
  type RosterParticipant,
  type RosterGroup,
  type PushSummary,
} from '../api'

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:          '#f7f3ef',   // warm parchment
  surface:     '#ffffff',
  heading:     '#2f1b14',   // deep espresso
  accent:      '#6e3d2f',   // wine-red — used ONLY on top stripe + action border
  text:        '#3d3530',   // warm charcoal
  muted:       '#8c7b72',   // secondary text
  border:      '#e8e0d8',   // warm divider
  mono:        "'Courier New', monospace",
}

const statusStyle: Record<string, { bg: string; color: string; border: string; label: string }> = {
  matched:    { bg: '#edf7f1', color: '#1a6b3c', border: '#2ecc71', label: 'Matched' },
  reporting:  { bg: '#fff8e8', color: '#7a5200', border: '#f0a500', label: 'Reporting' },
  completed:  { bg: '#edf1fb', color: '#1e4e8c', border: '#3b82f6', label: 'Completed' },
  deadlocked: { bg: '#fdf0f0', color: '#8b1a1a', border: '#ef4444', label: 'Deadlocked' },
}

function statusChip(status: string) {
  const s = statusStyle[status] ?? { bg: '#f3f4f6', color: '#374151', border: '#9ca3af', label: status }
  return (
    <span style={{
      display:      'inline-block',
      padding:      '0.2rem 0.6rem',
      borderRadius: 4,
      fontSize:     '0.78rem',
      fontWeight:   600,
      letterSpacing:'0.03em',
      background:   s.bg,
      color:        s.color,
      borderLeft:   `3px solid ${s.border}`,
    }}>
      {s.label}
    </span>
  )
}

// ── Roster table ──────────────────────────────────────────────────────────────

type GroupMeta = { number: number; status: string }

function RosterTable({ participants, groups }: { participants: RosterParticipant[]; groups: RosterGroup[] }) {
  const sortedGroups = [...groups].sort((a, b) => a.group_id.localeCompare(b.group_id))
  const groupMeta = new Map<string, GroupMeta>(
    sortedGroups.map((g, i) => [g.group_id, { number: i + 1, status: g.status }])
  )

  const sorted = [...participants].sort((a, b) => {
    const ga = a.group_id ? (groupMeta.get(a.group_id)?.number ?? 999) : 999
    const gb = b.group_id ? (groupMeta.get(b.group_id)?.number ?? 999) : 999
    if (ga !== gb) return ga - gb
    return (a.role ?? '').localeCompare(b.role ?? '')
  })

  if (sorted.length === 0) {
    return <p style={{ color: C.muted, fontSize: '0.9rem', margin: 0 }}>No participants yet.</p>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${C.border}` }}>
            {['Name', 'Role', 'Group', 'Status', 'Lead'].map(h => (
              <th key={h} style={{
                textAlign:    'left',
                padding:      '0.5rem 0.75rem',
                color:        C.muted,
                fontWeight:   600,
                fontSize:     '0.75rem',
                letterSpacing:'0.06em',
                textTransform:'uppercase',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((p, i) => {
            const meta = p.group_id ? groupMeta.get(p.group_id) : null
            return (
              <tr key={p.participant_id} style={{
                background:   i % 2 === 0 ? C.surface : '#faf7f4',
                borderBottom: `1px solid ${C.border}`,
              }}>
                <td style={{ padding: '0.5rem 0.75rem', color: C.text, fontWeight: 500 }}>
                  {p.display_name}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: C.text }}>
                  {p.role_label ?? p.role ?? '—'}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: meta ? C.text : C.muted }}>
                  {meta ? `G-${meta.number}` : '—'}
                </td>
                <td style={{ padding: '0.5rem 0.75rem' }}>
                  {meta ? statusChip(meta.status) : <span style={{ color: C.muted }}>—</span>}
                </td>
                <td style={{ padding: '0.5rem 0.75rem', color: C.muted, fontSize: '0.8rem' }}>
                  {p.is_lead ? '★' : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Group status summary ──────────────────────────────────────────────────────

function GroupSummary({ groups }: { groups: RosterGroup[] }) {
  const sorted = [...groups].sort((a, b) => a.group_id.localeCompare(b.group_id))
  if (sorted.length === 0) {
    return <p style={{ color: C.muted, fontSize: '0.9rem', margin: 0 }}>Groups will appear after matching.</p>
  }
  return (
    <div style={{ display: 'flex', gap: '0.625rem', flexWrap: 'wrap' }}>
      {sorted.map((g, i) => (
        <div key={g.group_id} style={{
          display:    'flex',
          alignItems: 'center',
          gap:        '0.5rem',
          background: C.surface,
          border:     `1px solid ${C.border}`,
          borderRadius: 6,
          padding:    '0.4rem 0.75rem',
          fontSize:   '0.85rem',
        }}>
          <span style={{ fontWeight: 700, color: C.heading }}>G-{i + 1}</span>
          {statusChip(g.status)}
        </div>
      ))}
    </div>
  )
}

// ── Action row ────────────────────────────────────────────────────────────────

function ActionButton({
  label, onClick, disabled, variant = 'primary',
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary'
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding:       '0.5rem 1.1rem',
        borderRadius:  5,
        border:        'none',
        cursor:        disabled ? 'not-allowed' : 'pointer',
        fontWeight:    600,
        fontSize:      '0.875rem',
        letterSpacing: '0.02em',
        background:    variant === 'primary'
          ? (disabled ? '#c5b5b0' : C.accent)
          : (disabled ? '#e8e0d8' : '#ede5de'),
        color:         variant === 'primary'
          ? '#fff'
          : (disabled ? C.muted : C.heading),
        opacity:       1,
        transition:    'background 0.15s',
      }}
    >
      {label}
    </button>
  )
}

function ResultLine({ text, isError }: { text: string; isError?: boolean }) {
  return (
    <p style={{
      margin:     0,
      marginTop:  '0.5rem',
      fontSize:   '0.82rem',
      color:      isError ? '#8b1a1a' : '#1a6b3c',
      fontFamily: isError ? 'inherit' : C.mono,
    }}>
      {text}
    </p>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function InstructorDashboard() {
  const [searchParams] = useSearchParams()

  const devGameInstanceId  = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null
  const tokenParam         = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError,    setAuthError]    = useState<string | null>(null)

  // ── Session bootstrap ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return

      const effectiveId = devGameInstanceId ?? gameInstanceIdParam
      if (auth.currentUser) {
        const expectedUid = effectiveId ? `instructor_${effectiveId}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) {
          setSessionReady(true)
          return
        }
        await signOut(auth)
        if (cancelled) return
      }

      const args = devGameInstanceId
        ? { _dev: { game_instance_id: devGameInstanceId } }
        : tokenParam
          ? { token: tokenParam }
          : null

      if (!args) {
        setAuthError('No launch token found. Please open this page from the classroom.')
        return
      }

      try {
        const { customToken } = await getInstructorSession(args)
        if (cancelled) return
        await signInWithCustomToken(auth, customToken)
        if (cancelled) return
        setSessionReady(true)
      } catch (err) {
        if (cancelled) return
        setAuthError(err instanceof Error ? err.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, [devGameInstanceId, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Roster ────────────────────────────────────────────────────────
  const [participants, setParticipants] = useState<RosterParticipant[]>([])
  const [groups,       setGroups]       = useState<RosterGroup[]>([])
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError,   setRosterError]   = useState<string | null>(null)

  const loadRoster = () => {
    setRosterLoading(true)
    setRosterError(null)
    getRoster()
      .then(r => { setParticipants(r.participants); setGroups(r.groups) })
      .catch(err => {
        const msg = err instanceof Error ? err.message : 'Failed to load roster.'
        if (isAuthError(err)) setAuthError(msg)
        else setRosterError(msg)
      })
      .finally(() => setRosterLoading(false))
  }

  useEffect(() => {
    if (!sessionReady) return
    ;(async () => {
      try { await syncRoster() } catch { /* non-fatal: self-joined students still show */ }
      loadRoster()
    })()
  }, [sessionReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Attendance code ───────────────────────────────────────────────
  const [attendanceCode,  setAttendanceCode]  = useState<string | null>(null)
  const [generating,      setGenerating]      = useState(false)
  const [codeError,       setCodeError]       = useState<string | null>(null)

  const handleGenerate = () => {
    setGenerating(true); setCodeError(null)
    generateAttendanceCode()
      .then(r => { setAttendanceCode(r.code); setGenerating(false) })
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Failed to generate code.')
        setGenerating(false)
      })
  }

  const projectCode = () => {
    if (!attendanceCode) return
    const w = window.open('', 'wm-code-projection', 'width=960,height=540,menubar=no,toolbar=no,location=no,status=no')
    if (!w) return
    w.document.write(
      `<!doctype html><html><head><title>Attendance Code</title>` +
      `<style>body{margin:0;display:flex;flex-direction:column;align-items:center;` +
      `justify-content:center;height:100vh;background:#1a0a06;color:#f7f3ef;` +
      `font-family:monospace;text-align:center;}p{font-size:1.25rem;opacity:.7;margin:0 0 1rem;}` +
      `h1{font-size:8rem;font-weight:700;letter-spacing:.3em;margin:0;}</style></head>` +
      `<body><p>Attendance Code</p><h1>${attendanceCode}</h1></body></html>`,
    )
    w.document.close()
  }

  // ── Trigger Matching ──────────────────────────────────────────────
  const [matching,     setMatching]     = useState(false)
  const [matchResult,  setMatchResult]  = useState<string | null>(null)
  const [matchError,   setMatchError]   = useState<string | null>(null)

  const handleMatch = () => {
    setMatching(true); setMatchResult(null); setMatchError(null)
    triggerMatching()
      .then(r => {
        const n = r.groups.length
        setMatchResult(r.alreadyMatched
          ? `Already matched — ${n} group${n !== 1 ? 's' : ''}.`
          : `Matched into ${n} group${n !== 1 ? 's' : ''}.`)
        loadRoster()
      })
      .catch(err => setMatchError(err instanceof Error ? err.message : 'Matching failed.'))
      .finally(() => setMatching(false))
  }

  // ── Finalize ──────────────────────────────────────────────────────
  const [finalizing,   setFinalizing]   = useState(false)
  const [finalResult,  setFinalResult]  = useState<string | null>(null)
  const [finalError,   setFinalError]   = useState<string | null>(null)

  const handleFinalize = () => {
    setFinalizing(true); setFinalResult(null); setFinalError(null)
    finalizeInstance()
      .then(() => { setFinalResult('Scores computed.'); loadRoster() })
      .catch(err => setFinalError(err instanceof Error ? err.message : 'Finalize failed.'))
      .finally(() => setFinalizing(false))
  }

  // ── Push to Gradebook ─────────────────────────────────────────────
  const [pushing,    setPushing]    = useState(false)
  const [pushResult, setPushResult] = useState<PushSummary | null>(null)
  const [pushError,  setPushError]  = useState<string | null>(null)

  const handlePush = () => {
    setPushing(true); setPushResult(null); setPushError(null)
    pushResultsToClassroom()
      .then(r => setPushResult({ total: r.total, succeeded: r.succeeded, failed: r.failed }))
      .catch(err => setPushError(err instanceof Error ? err.message : 'Push failed.'))
      .finally(() => setPushing(false))
  }

  // ── Derived ───────────────────────────────────────────────────────
  const effectiveGameInstanceId = devGameInstanceId ?? gameInstanceIdParam
    ?? auth.currentUser?.uid.replace(/^instructor_/, '')

  // ── Auth error screen ─────────────────────────────────────────────
  if (authError) {
    return (
      <main style={{ background: C.bg, minHeight: '100vh', padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{
          maxWidth:     480,
          margin:       '4rem auto',
          background:   C.surface,
          borderRadius: 8,
          padding:      '1.5rem',
          border:       `1px solid ${C.border}`,
          borderTop:    `4px solid #8b1a1a`,
        }}>
          <p style={{ margin: '0 0 0.5rem', fontWeight: 700, color: '#8b1a1a', fontSize: '0.95rem' }}>
            Session error
          </p>
          <p style={{ margin: '0 0 1rem', color: C.text, fontSize: '0.9rem', lineHeight: 1.5 }}>
            {authError}
          </p>
          <p style={{ margin: 0, color: C.muted, fontSize: '0.82rem' }}>
            Return to the classroom and click Launch to get a fresh link.
          </p>
        </div>
      </main>
    )
  }

  // ── Loading screen ────────────────────────────────────────────────
  if (!sessionReady) {
    return (
      <main style={{ background: C.bg, minHeight: '100vh', padding: '2rem', fontFamily: 'system-ui, sans-serif', color: C.muted, textAlign: 'center', paddingTop: '6rem' }}>
        Establishing session…
      </main>
    )
  }

  // ── Dashboard ─────────────────────────────────────────────────────
  return (
    <div style={{ background: C.bg, minHeight: '100vh', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Top accent stripe */}
      <div style={{ height: 4, background: C.accent }} />

      {/* Page header */}
      <header style={{
        background:   C.surface,
        borderBottom: `1px solid ${C.border}`,
        padding:      '0.875rem 2rem',
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'space-between',
        gap:          '1rem',
      }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: '1rem', color: C.heading, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Winemaster
          </span>
          <span style={{ marginLeft: '0.75rem', color: C.muted, fontSize: '0.78rem' }}>
            Instructor Dashboard
          </span>
        </div>
        {effectiveGameInstanceId && (
          <span style={{ fontFamily: C.mono, fontSize: '0.72rem', color: C.muted, letterSpacing: '0.04em' }}>
            {effectiveGameInstanceId.slice(0, 8)}…
          </span>
        )}
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem 2rem' }}>

        {/* ── Actions ───────────────────────────────────────────── */}
        <section style={{
          background:   C.surface,
          border:       `1px solid ${C.border}`,
          borderLeft:   `3px solid ${C.accent}`,
          borderRadius: '0 6px 6px 0',
          padding:      '1.25rem 1.5rem',
          marginBottom: '1.5rem',
        }}>
          <p style={{ margin: '0 0 1rem', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>
            Actions
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>

            {/* Generate Attendance Code */}
            <div>
              {attendanceCode ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{
                    fontFamily:    C.mono,
                    fontWeight:    700,
                    fontSize:      '1.5rem',
                    letterSpacing: '0.25em',
                    color:         C.accent,
                    background:    '#f9f0ec',
                    padding:       '0.2rem 0.6rem',
                    borderRadius:  4,
                    border:        `1px solid ${C.border}`,
                  }}>
                    {attendanceCode}
                  </span>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    title="Regenerate — invalidates the current code"
                    style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', cursor: generating ? 'not-allowed' : 'pointer' }}
                  >
                    {generating ? '…' : '↻'}
                  </button>
                  <button
                    onClick={projectCode}
                    title="Open code in a projectable full-screen window"
                    style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                  >
                    Project
                  </button>
                </div>
              ) : (
                <ActionButton
                  label={generating ? 'Generating…' : 'Generate Code'}
                  onClick={handleGenerate}
                  disabled={generating || !sessionReady}
                  variant="primary"
                />
              )}
              {codeError && <ResultLine text={codeError} isError />}
            </div>

            {/* Trigger Matching */}
            <div>
              <ActionButton
                label={matching ? 'Matching…' : 'Trigger Matching'}
                onClick={handleMatch}
                disabled={matching || !sessionReady}
              />
              {matchResult && <ResultLine text={matchResult} />}
              {matchError  && <ResultLine text={matchError}  isError />}
            </div>

            {/* Finalize */}
            <div>
              <ActionButton
                label={finalizing ? 'Computing…' : 'Finalize'}
                onClick={handleFinalize}
                disabled={finalizing || !sessionReady}
                variant="secondary"
              />
              {finalResult && <ResultLine text={finalResult} />}
              {finalError  && <ResultLine text={finalError}  isError />}
            </div>

            {/* Push to Gradebook */}
            <div>
              <ActionButton
                label={pushing ? 'Pushing…' : 'Push to Gradebook'}
                onClick={handlePush}
                disabled={pushing || !sessionReady}
                variant="secondary"
              />
              {pushResult && (
                <ResultLine text={
                  pushResult.failed.length === 0
                    ? `${pushResult.succeeded}/${pushResult.total} pushed.`
                    : `${pushResult.succeeded}/${pushResult.total} pushed; ${pushResult.failed.length} failed.`
                } isError={pushResult.failed.length > 0} />
              )}
              {pushError && <ResultLine text={pushError} isError />}
            </div>

          </div>
        </section>

        {/* ── Group status ──────────────────────────────────────── */}
        <section style={{
          background:   C.surface,
          border:       `1px solid ${C.border}`,
          borderRadius: 6,
          padding:      '1.25rem 1.5rem',
          marginBottom: '1.5rem',
        }}>
          <p style={{ margin: '0 0 0.875rem', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>
            Groups
          </p>
          <GroupSummary groups={groups} />
        </section>

        {/* ── Roster ───────────────────────────────────────────── */}
        <section style={{
          background:   C.surface,
          border:       `1px solid ${C.border}`,
          borderRadius: 6,
          padding:      '1.25rem 1.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.875rem' }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.muted }}>
              Participants
              {participants.length > 0 && <span style={{ marginLeft: '0.5rem', fontWeight: 400 }}>({participants.length})</span>}
            </p>
            <button
              onClick={loadRoster}
              disabled={rosterLoading}
              style={{
                background: 'none',
                border:     `1px solid ${C.border}`,
                borderRadius: 4,
                padding:    '0.25rem 0.625rem',
                cursor:     rosterLoading ? 'not-allowed' : 'pointer',
                fontSize:   '0.78rem',
                color:      C.muted,
              }}
            >
              {rosterLoading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
          {rosterError && (
            <p style={{ color: '#8b1a1a', fontSize: '0.85rem', margin: '0 0 0.75rem' }}>{rosterError}</p>
          )}
          <RosterTable participants={participants} groups={groups} />
        </section>

      </main>
    </div>
  )
}
