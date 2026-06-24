import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { InstructorDashboard as SharedDashboard, type DeadlockResolutionProps, type SharedGroup, type OutcomeFields } from '@mygames/game-ui'
import { auth, functions, rtdb } from '../firebase'
import { winemasterConfig, winemasterSchema, formatField, FIELD_LABELS } from '../gameConfig'

// ── Role labels from game config ──────────────────────────────────────────────

const roleLabels = Object.fromEntries(
  winemasterConfig.roles.map(r => [r.key, r.label])
)

// ── Outcome formatting ────────────────────────────────────────────────────────

function formatGroupOutcome(group: SharedGroup): string {
  if (group.agreement_reached === false) return 'No deal'
  if (!group.outcome || group.agreement_reached == null) return '—'
  return winemasterSchema
    .map(f => `${FIELD_LABELS[f.key]}: ${formatField(f, group.outcome![f.key])}`)
    .join(' · ')
}

// ── Deadlock resolution control ───────────────────────────────────────────────

const VESTING_OPTIONS = ['Immediate', 'Pro Rata', 'End of Second Year'] as const

function WinemasterDeadlockControl({ submitting, error, onSubmit }: DeadlockResolutionProps) {
  const [shares,    setShares]    = useState('')
  const [vesting,   setVesting]   = useState<string>(VESTING_OPTIONS[0])
  const [boardSeat, setBoardSeat] = useState(false)
  const [liability, setLiability] = useState('')
  const [noDeal,    setNoDeal]    = useState(false)

  const handleSubmit = () => {
    if (noDeal) { onSubmit({ no_deal: true }); return }
    const sharesNum    = parseInt(shares.replace(/,/g, ''), 10)
    const liabilityNum = parseInt(liability.replace(/[$,]/g, ''), 10)
    if (isNaN(sharesNum) || isNaN(liabilityNum)) return
    const outcome: OutcomeFields = { shares: sharesNum, vesting, board_seat: boardSeat, liability: liabilityNum }
    onSubmit(outcome)
  }

  const inputStyle: React.CSSProperties = {
    fontSize: '0.875rem', padding: '0.3rem 0.5rem', borderRadius: 3, border: '1px solid #ccc',
  }
  const fieldStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {!noDeal && (
        <>
          <div style={fieldStyle}>
            <label style={{ fontSize: '0.875rem', minWidth: '6rem' }}>Shares</label>
            <input type="text" inputMode="numeric" placeholder="e.g. 100000" value={shares}
              onChange={e => setShares(e.target.value)} style={{ ...inputStyle, width: '9rem' }} disabled={submitting} />
          </div>
          <div style={fieldStyle}>
            <label style={{ fontSize: '0.875rem', minWidth: '6rem' }}>Vesting</label>
            <select value={vesting} onChange={e => setVesting(e.target.value)} style={inputStyle} disabled={submitting}>
              {VESTING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div style={fieldStyle}>
            <label style={{ fontSize: '0.875rem', minWidth: '6rem' }}>Board seat</label>
            <input type="checkbox" checked={boardSeat} onChange={e => setBoardSeat(e.target.checked)} disabled={submitting} />
          </div>
          <div style={fieldStyle}>
            <label style={{ fontSize: '0.875rem', minWidth: '6rem' }}>Liability ($)</label>
            <input type="text" inputMode="numeric" placeholder="e.g. 50000" value={liability}
              onChange={e => setLiability(e.target.value)} style={{ ...inputStyle, width: '9rem' }} disabled={submitting} />
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.25rem' }}>
        <button onClick={handleSubmit} disabled={submitting || (!noDeal && (!shares || !liability))}>
          {submitting ? '…' : noDeal ? 'Confirm No Deal' : 'Lock Deal'}
        </button>
        <button onClick={() => setNoDeal(v => !v)} disabled={submitting} style={{ background: 'none', border: '1px solid #ccc' }}>
          {noDeal ? 'Enter deal terms instead' : 'No deal'}
        </button>
      </div>
      {error && <p style={{ color: '#c00', fontSize: '0.8rem', margin: 0 }}>{error}</p>}
    </div>
  )
}

// ── Submit instructor outcome ─────────────────────────────────────────────────

async function submitInstructorOutcome(groupId: string, outcome: OutcomeFields): Promise<void> {
  const fn = httpsCallable(functions, 'submitInstructorOutcome')
  await fn({ group_id: groupId, outcome })
}

// ── Page component ────────────────────────────────────────────────────────────

export default function InstructorDashboard() {
  return (
    <SharedDashboard
      title="Instructor Dashboard — Winemaster"
      roleLabels={roleLabels}
      formatGroupOutcome={formatGroupOutcome}
      DeadlockResolutionControl={WinemasterDeadlockControl}
      submitInstructorOutcome={submitInstructorOutcome}
      functions={functions}
      auth={auth}
      rtdb={rtdb}
      settingsRoute="/settings"
    />
  )
}
