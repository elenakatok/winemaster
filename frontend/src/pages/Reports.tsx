import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  SortableTable,
  ReportBoard,
  GameHeader,
  type SortableColumn,
  type ReportTileConfig,
} from '@mygames/game-ui'

type ReportRow = {
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

// ── Vesting sort order ────────────────────────────────────────────────────────

const VESTING_ORDER: Record<string, number> = {
  'Immediate': 0,
  'Pro Rata': 1,
  'End of Second Year': 2,
}

const vestingRank = (v: string | null) => v == null ? Infinity : (VESTING_ORDER[v] ?? 3)

// ── Column definitions ────────────────────────────────────────────────────────

type SortKey = 'name' | 'group' | 'role' | 'shares' | 'vesting' | 'board_seat' | 'liability' | 'value_or_cost' | 'raw_score'

const ROLE_LABELS: Record<string, string> = {
  winemaster: 'Winemaster',
  home_base:  'Home Base',
}

function fmt(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

function fmtSigned(n: number | null): string {
  if (n == null) return '—'
  return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-US')
}

const COLUMNS: readonly SortableColumn<ReportRow, SortKey>[] = [
  {
    key: 'name',
    label: 'Name',
    headerStyle: { minWidth: 140 },
    render: r => r.display_name,
    compare: (a, b) => a.display_name.localeCompare(b.display_name),
  },
  {
    key: 'group',
    label: 'Group #',
    render: r => r.group_number ?? '—',
    compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity),
  },
  {
    key: 'role',
    label: 'Role',
    render: r => r.role === 'winemaster' ? 'Winemaster' : 'Home Base',
    compare: (a, b) => a.role.localeCompare(b.role),
  },
  {
    key: 'shares',
    label: 'Shares',
    nullsLast: true,
    isNull: r => r.shares === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.shares)}</span>,
    compare: (a, b) => (a.shares ?? 0) - (b.shares ?? 0),
  },
  {
    key: 'vesting',
    label: 'Vesting',
    nullsLast: true,
    isNull: r => r.vesting === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => r.vesting ?? '—',
    compare: (a, b) => vestingRank(a.vesting) - vestingRank(b.vesting),
  },
  {
    key: 'board_seat',
    label: 'Board seat',
    nullsLast: true,
    isNull: r => r.board_seat === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => r.board_seat === null ? '—' : r.board_seat ? 'Yes' : 'No',
    compare: (a, b) => (a.board_seat ? 1 : 0) - (b.board_seat ? 1 : 0),
  },
  {
    key: 'liability',
    label: 'Liability',
    nullsLast: true,
    isNull: r => r.liability === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.liability)}</span>,
    compare: (a, b) => (a.liability ?? 0) - (b.liability ?? 0),
  },
  {
    key: 'value_or_cost',
    label: 'Value / Cost',
    nullsLast: true,
    isNull: r => r.value_or_cost === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => (
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmt(r.value_or_cost)}
      </span>
    ),
    compare: (a, b) => (a.value_or_cost ?? 0) - (b.value_or_cost ?? 0),
  },
  {
    key: 'raw_score',
    label: 'Raw score',
    nullsLast: true,
    isNull: r => r.raw_score === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtSigned(r.raw_score)}</span>,
    compare: (a, b) => (a.raw_score ?? 0) - (b.raw_score ?? 0),
  },
]

// ── Page component ────────────────────────────────────────────────────────────

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null
  const tokenParam          = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError,    setAuthError]    = useState<string | null>(null)

  // Propagate URL params to same-origin links so the session follows navigation.
  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap (same pattern as shared InstructorDashboard) ────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return

      if (auth.currentUser) {
        const expectedUid = devGameInstanceId
          ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam
            ? `instructor_${gameInstanceIdParam}`
            : null
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
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
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

  // ── Data load ──────────────────────────────────────────────────────────────
  const [rows,    setRows]    = useState<ReportRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    const fn = httpsCallable<object, { ok: boolean; rows: ReportRow[] }>(functions, 'getReportData')
    fn({}).then(r => {
      setRows(r.data.rows)
      setLoading(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to load report data.')
      setLoading(false)
    })
  }, [sessionReady])

  // ── Tile config ────────────────────────────────────────────────────────────
  const finalized = rows?.length ?? 0
  const tiles: ReportTileConfig[] = [
    {
      id: 'contract-outcomes',
      title: 'Contract Outcomes — per participant',
      preview: rows == null
        ? <span style={{ color: '#888', fontSize: '0.85rem' }}>{loading ? 'Loading…' : 'No data'}</span>
        : <span style={{ fontSize: '0.9rem', color: '#555' }}>
            {finalized} participant{finalized !== 1 ? 's' : ''} finalized
          </span>,
      onOpen: () => setModalOpen(true),
      disabled: !rows || rows.length === 0,
      actionLabel: 'Open ↗',
    },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authError) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: '#c00' }}>{authError}</p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />

      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button
          onClick={() => navigate(makeLink('/dashboard'))}
          style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          ← Dashboard
        </button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — Winemaster</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        <ReportBoard tiles={tiles} />
      </main>

      {/* ── Contract outcomes modal ── */}
      {modalOpen && (
        <div
          onClick={() => setModalOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '3rem 1rem', zIndex: 1000, overflowY: 'auto',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              width: '100%', maxWidth: 1100, padding: '1.25rem 1.5rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Contract Outcomes — per participant</h3>
              <button
                onClick={() => setModalOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <SortableTable<ReportRow, SortKey>
                rows={rows ?? []}
                columns={COLUMNS}
                getRowKey={r => r.participant_id}
                initialSortKey="group"
                roleLabels={ROLE_LABELS}
                getRowRole={r => r.role}
                emptyMessage="No finalized participants yet."
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
