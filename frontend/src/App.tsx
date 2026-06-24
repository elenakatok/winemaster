import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import Configure from './pages/Configure'
import { SettingsPage } from '@mygames/game-ui'

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
