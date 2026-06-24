import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { doc, getDoc } from 'firebase/firestore'
import { db, auth, functions } from './firebase'
import OutcomeReporting from './phases/OutcomeReporting'
import InstructorDashboard from './pages/InstructorDashboard'
import Configure from './pages/Configure'
import { SettingsPage } from '@mygames/game-ui'
import type { CallArgs } from './api'

const winemasterRoleLabels: Record<string, string> = {
  winemaster: 'Winemaster',
  home_base:  'Home Base',
}

const winemasterInfoLinks = [
  { roleKey: 'winemaster', links: [
    { key: 'winemaster_sheet_url',     label: 'Role sheet' },
    { key: 'winemaster_worksheet_url', label: 'Worksheet'  },
  ]},
  { roleKey: 'home_base', links: [
    { key: 'home_base_sheet_url',     label: 'Role sheet' },
    { key: 'home_base_worksheet_url', label: 'Worksheet'  },
  ]},
]

// ── Student participant entry at / ────────────────────────────────────────────
// Dev: ?gameId=&pid= query params resolve the participant and render the outcome
// form directly. Production participant flow is a future slice.

type DevRoute = {
  gameId:  string
  pid:     string
  groupId: string
  isLead:  boolean
  args:    CallArgs
}

function Play() {
  const [devRoute, setDevRoute] = useState<DevRoute | null>(null)
  const [loading,  setLoading]  = useState(false)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const p      = new URLSearchParams(window.location.search)
    const gameId = p.get('gameId')
    const pid    = p.get('pid')
    if (!gameId || !pid) return

    setLoading(true)
    void getDoc(doc(db, 'game_instances', gameId, 'participants', pid)).then(snap => {
      setLoading(false)
      if (!snap.exists()) { console.warn('[dev] participant not found:', pid); return }
      const d       = snap.data()
      const groupId = d['group_id'] as string | undefined
      if (!groupId) { console.warn('[dev] participant has no group_id yet:', pid); return }
      setDevRoute({
        gameId,
        pid,
        groupId,
        isLead: d['is_lead'] as boolean,
        args:   { _test: { participant_id: pid, game_instance_id: gameId } },
      })
    })
  }, [])

  if (import.meta.env.DEV && loading) {
    return (
      <main style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
        <p>Loading participant…</p>
      </main>
    )
  }

  if (import.meta.env.DEV && devRoute) {
    return (
      <OutcomeReporting
        groupId={devRoute.groupId}
        participantId={devRoute.pid}
        gameInstanceId={devRoute.gameId}
        isLead={devRoute.isLead}
        args={devRoute.args}
        onComplete={() => console.log('[dev] OutcomeReporting onComplete fired')}
      />
    )
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem', textAlign: 'center' }}>
      <h1>Winemaster</h1>
      <p>Coming soon.</p>
    </div>
  )
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — Winemaster"
            functions={functions}
            auth={auth}
            roleLabels={winemasterRoleLabels}
            roleInfoLinks={winemasterInfoLinks}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
