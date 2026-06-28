import { type RoleConfig } from '@mygames/game-engine/roles'
import { type OutcomeField, type OutcomeSchema } from '@mygames/game-engine/outcome'

export type { RoleConfig, OutcomeField, OutcomeSchema }

export const winemasterConfig: RoleConfig = {
  roles: [
    { key: 'winemaster', label: 'Winemaster', short: 'W' },
    { key: 'home_base',  label: 'Home Base',  short: 'H' },
  ],
}

// Mirrors functions/src/gameDefinition.ts — shares max 500_000 from B5.1.
export const winemasterSchema: OutcomeSchema = [
  { key: 'shares',     type: 'integer', min: 0,   max: 500_000  },
  { key: 'vesting',    type: 'enum',    options: ['Immediate', 'Pro Rata', 'End of Second Year'] },
  { key: 'board_seat', type: 'boolean' },
  { key: 'liability',  type: 'integer', min: 0,   max: 1_000_000 },
  { key: 'notes',      type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  shares:     'Shares',
  vesting:    'Vesting',
  board_seat: 'Board seat',
  liability:  'Liability',
  notes:      'Notes',
}

export function formatField(field: OutcomeField, value: unknown): string {
  if (field.type === 'integer') {
    const n = value as number
    return field.key === 'liability'
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        }).format(n)
      : n.toLocaleString('en-US')
  }
  if (field.type === 'enum')    return value as string
  if (field.type === 'boolean') return (value as boolean) ? 'Yes' : 'No'
  return String(value)
}
