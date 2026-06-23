// Mirrors functions/src/gameDefinition.ts — kept in sync manually.
// The frontend is self-contained; it does not import from the functions package.

export type IntegerField = { key: string; type: 'integer'; min: number; max: number }
export type EnumField    = { key: string; type: 'enum'; options: readonly string[] }
export type BooleanField = { key: string; type: 'boolean' }
export type FieldDef     = IntegerField | EnumField | BooleanField

export const winemasterSchema: readonly FieldDef[] = [
  { key: 'shares',     type: 'integer', min: 0,   max: 500_000  },
  { key: 'vesting',    type: 'enum',    options: ['Immediate', 'Pro Rata', 'End of Second Year'] },
  { key: 'board_seat', type: 'boolean' },
  { key: 'liability',  type: 'integer', min: 0,   max: 1_000_000 },
] as const

type RoleDef = { key: string; label: string }

const winemasterRoles: readonly RoleDef[] = [
  { key: 'winemaster', label: 'Winemaster' },
  { key: 'home_base',  label: 'Home Base'  },
] as const

export function labelFor(roleKey: string): string {
  return winemasterRoles.find(r => r.key === roleKey)?.label ?? roleKey
}

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  shares:     'Shares',
  vesting:    'Vesting',
  board_seat: 'Board seat',
  liability:  'Liability',
}

export function formatField(field: FieldDef, value: unknown): string {
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
