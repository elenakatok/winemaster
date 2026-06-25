import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  SortableTable,
  ReportBoard,
  GameHeader,
  ExportModal,
  buildStudentTextExport,
  type SortableColumn,
  type ReportTileConfig,
  type AiTextRow,
} from '@mygames/game-ui'
import { SurplusScatterSVG, type ScatterPoint } from '../components/SurplusScatterSVG'

// ── Types ─────────────────────────────────────────────────────────────────────

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
  text_answers: Record<string, string>
}

type QuestionMeta = { field: string; prompt: string; role_target: string }

// ── Vesting sort order ────────────────────────────────────────────────────────

const VESTING_ORDER: Record<string, number> = {
  'Immediate': 0,
  'Pro Rata': 1,
  'End of Second Year': 2,
}

const vestingRank = (v: string | null) => v == null ? Infinity : (VESTING_ORDER[v] ?? 3)

// ── Contract-outcome table columns ───────────────────────────────────────────

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
    key: 'name', label: 'Name', headerStyle: { minWidth: 140 },
    render: r => r.display_name,
    compare: (a, b) => a.display_name.localeCompare(b.display_name),
  },
  {
    key: 'group', label: 'Group #',
    render: r => r.group_number ?? '—',
    compare: (a, b) => (a.group_number ?? Infinity) - (b.group_number ?? Infinity),
  },
  {
    key: 'role', label: 'Role',
    render: r => r.role === 'winemaster' ? 'Winemaster' : 'Home Base',
    compare: (a, b) => a.role.localeCompare(b.role),
  },
  {
    key: 'shares', label: 'Shares', nullsLast: true, isNull: r => r.shares === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.shares)}</span>,
    compare: (a, b) => (a.shares ?? 0) - (b.shares ?? 0),
  },
  {
    key: 'vesting', label: 'Vesting', nullsLast: true, isNull: r => r.vesting === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => r.vesting ?? '—',
    compare: (a, b) => vestingRank(a.vesting) - vestingRank(b.vesting),
  },
  {
    key: 'board_seat', label: 'Board seat', nullsLast: true, isNull: r => r.board_seat === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => r.board_seat === null ? '—' : r.board_seat ? 'Yes' : 'No',
    compare: (a, b) => (a.board_seat ? 1 : 0) - (b.board_seat ? 1 : 0),
  },
  {
    key: 'liability', label: 'Liability', nullsLast: true, isNull: r => r.liability === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.liability)}</span>,
    compare: (a, b) => (a.liability ?? 0) - (b.liability ?? 0),
  },
  {
    key: 'value_or_cost', label: 'Value / Cost', nullsLast: true, isNull: r => r.value_or_cost === null,
    tiebreak: (a, b) => a.display_name.localeCompare(b.display_name),
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(r.value_or_cost)}</span>,
    compare: (a, b) => (a.value_or_cost ?? 0) - (b.value_or_cost ?? 0),
  },
  {
    key: 'raw_score', label: 'Raw score', nullsLast: true, isNull: r => r.raw_score === null,
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

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId
          ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId
        ? { _dev: { game_instance_id: devGameInstanceId } }
        : tokenParam ? { token: tokenParam } : null
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
  const [rows,      setRows]      = useState<ReportRow[] | null>(null)
  const [questions, setQuestions] = useState<QuestionMeta[]>([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    const fn = httpsCallable<object, { ok: boolean; rows: ReportRow[]; questions: QuestionMeta[] }>(functions, 'getReportData')
    fn({}).then(r => {
      setRows(r.data.rows)
      setQuestions(r.data.questions)
      setLoading(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to load report data.')
      setLoading(false)
    })
  }, [sessionReady])

  // ── Scatter data — derived from rows, no extra fetch ───────────────────────
  const scatterSvgRef = useRef<SVGSVGElement>(null)

  const scatterPoints: ScatterPoint[] = (() => {
    if (!rows) return []
    const groupMap = new Map<number, { wm: number | null; hb: number | null }>()
    for (const r of rows) {
      if (r.group_number == null || r.raw_score == null) continue
      const entry = groupMap.get(r.group_number) ?? { wm: null, hb: null }
      if (r.role === 'winemaster') entry.wm = entry.wm ?? r.raw_score
      else if (r.role === 'home_base') entry.hb = entry.hb ?? r.raw_score
      groupMap.set(r.group_number, entry)
    }
    return Array.from(groupMap.entries())
      .filter(([, s]) => s.wm !== null && s.hb !== null)
      .map(([n, s]) => ({ x: s.hb!, y: s.wm!, label: `G${n}` }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })()

  // ── Modal state ────────────────────────────────────────────────────────────
  const [contractOpen,  setContractOpen]  = useState(false)
  const [activeExport,  setActiveExport]  = useState<{ title: string; text: string } | null>(null)

  // ── Tile config ────────────────────────────────────────────────────────────
  const finalized = rows?.length ?? 0

  const projectScatter = () => {
    if (!scatterSvgRef.current) return
    const svgHtml = scatterSvgRef.current.outerHTML
    const win = window.open('', 'surplus-scatter', 'width=960,height=600')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><title>Surplus Scatter</title></head><body style="margin:0;padding:1rem;background:#fff;">${svgHtml}</body></html>`)
    win.document.close()
  }

  const tiles: ReportTileConfig[] = [
    {
      id: 'contract-outcomes',
      title: 'Contract Outcomes — per participant',
      preview: rows == null
        ? <span style={{ color: '#888', fontSize: '0.85rem' }}>{loading ? 'Loading…' : 'No data'}</span>
        : <span style={{ fontSize: '0.9rem', color: '#555' }}>
            {finalized} participant{finalized !== 1 ? 's' : ''} finalized
          </span>,
      onOpen: () => setContractOpen(true),
      disabled: !rows || rows.length === 0,
      actionLabel: 'Open ↗',
    },
    {
      id: 'surplus-scatter',
      title: 'Surplus Scatter — WM vs. HB',
      preview: <SurplusScatterSVG points={scatterPoints} svgRef={scatterSvgRef} />,
      onOpen: projectScatter,
      disabled: scatterPoints.length === 0,
      actionLabel: 'Project ↗',
    },
    // One tile per text question (6 total: 3 WM + 3 HB).
    ...questions.map(q => {
      const roleLabel = ROLE_LABELS[q.role_target] ?? q.role_target
      const tileTitle = `${roleLabel}: ${q.prompt}`
      const qRows: AiTextRow[] = (rows ?? [])
        .filter(r => r.role === q.role_target && r.text_answers[q.field])
        .map(r => ({ name: r.display_name, raw_score: r.raw_score, answer: r.text_answers[q.field] }))
      const text = buildStudentTextExport(tileTitle, qRows)
      return {
        id: q.field,
        title: tileTitle,
        preview: qRows.length === 0
          ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No responses yet.</span>
          : <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111' }}>
              {qRows.length} response{qRows.length !== 1 ? 's' : ''}
            </span>,
        onOpen: () => setActiveExport({ title: tileTitle, text }),
        disabled: !rows,
        actionLabel: 'Open ↗',
      } satisfies ReportTileConfig
    }),
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
      {contractOpen && (
        <div
          onClick={() => setContractOpen(false)}
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
                onClick={() => setContractOpen(false)}
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

      {/* ── AI text export modal (shared across all text tiles) ── */}
      {activeExport && (
        <ExportModal
          title={activeExport.title}
          text={activeExport.text}
          onClose={() => setActiveExport(null)}
        />
      )}
    </div>
  )
}
