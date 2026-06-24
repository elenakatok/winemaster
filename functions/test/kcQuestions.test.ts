import { describe, it, expect } from 'vitest'
import { validateQuestionSemantics, validateKCGate, parsePrepTextQuestions } from '@mygames/game-server'
import { winemasterGameDef } from '../src/gameDefinition'

const ROLES = winemasterGameDef.roles.roles.map(r => r.key)
const questions = winemasterGameDef.prepDefaults!

describe('Winemaster prepDefaults — structural integrity', () => {
  it('parses as valid PrepTextQuestion[] (no type/field errors)', () => {
    const result = parsePrepTextQuestions(questions)
    expect(result).not.toBeNull()
  })

  it('passes validateQuestionSemantics (correct_value in options, no assigned_role+correct_value clash)', () => {
    expect(validateQuestionSemantics(questions)).toBeNull()
  })

  it('passes validateKCGate for both roles', () => {
    expect(validateKCGate(ROLES, questions)).toBeNull()
  })

  it('has no duplicate field names', () => {
    const fields = questions.map(q => q.field)
    expect(new Set(fields).size).toBe(fields.length)
  })
})

describe('Winemaster prepDefaults — per-role question counts', () => {
  for (const role of ROLES) {
    it(`${role}: sees exactly 8 questions (1 gate + 4 graded MC + 3 reflection)`, () => {
      const visible = questions.filter(q => q.role_target === role || q.role_target === 'all')
      expect(visible).toHaveLength(8)

      const gate     = visible.filter(q => q.grading === 'assigned_role' && q.system)
      const gradedMC = visible.filter(q => q.grading === 'static' && q.category === 'knowledge_check')
      const reflect  = visible.filter(q => q.category === 'preparation')

      expect(gate).toHaveLength(1)
      expect(gradedMC).toHaveLength(4)
      expect(reflect).toHaveLength(3)
    })
  }
})

describe('Winemaster prepDefaults — gate question flags', () => {
  const gates = questions.filter(q => q.grading === 'assigned_role')

  it('gate questions are system:true', () => {
    for (const g of gates) expect(g.system).toBe(true)
  })

  it('gate questions are deletable:false', () => {
    for (const g of gates) expect(g.deletable).toBe(false)
  })

  it('gate questions have no correct_value', () => {
    for (const g of gates) expect(g.correct_value).toBeUndefined()
  })

  it('gate questions have options for both roles', () => {
    for (const g of gates) {
      const vals = (g.options ?? []).map(o => o.value)
      expect(vals).toContain('winemaster')
      expect(vals).toContain('home_base')
    }
  })
})

describe('Winemaster prepDefaults — graded MC flags', () => {
  const graded = questions.filter(q => q.grading === 'static')

  it('all graded questions are system:false', () => {
    for (const q of graded) expect(q.system).toBe(false)
  })

  it('all graded questions are deletable:false', () => {
    for (const q of graded) expect(q.deletable).toBe(false)
  })

  it('all graded questions have correct_value matching one of their options', () => {
    for (const q of graded) {
      const vals = (q.options ?? []).map(o => o.value)
      expect(vals).toContain(q.correct_value)
    }
  })

  it('all graded questions have explanation text', () => {
    for (const q of graded) {
      expect(typeof q.explanation).toBe('string')
      expect(q.explanation!.length).toBeGreaterThan(0)
    }
  })

  it('no explanation references a positional label (shuffle-safe)', () => {
    const positional = /\b(option [abcde]|choice [abcde]|answer [abcde]|\(a\)|\(b\)|\(c\)|\(d\)|\(e\)|first option|second option|third option|fourth option|fifth option|sixth option)\b/i
    for (const q of graded) {
      if (q.explanation) expect(q.explanation).not.toMatch(positional)
    }
  })
})

describe('Winemaster prepDefaults — reflection question flags', () => {
  const reflect = questions.filter(q => q.category === 'preparation')

  it('reflection questions are system:false', () => {
    for (const q of reflect) expect(q.system).toBe(false)
  })

  it('reflection questions are deletable:true', () => {
    for (const q of reflect) expect(q.deletable).toBe(true)
  })

  it('reflection questions have format:text', () => {
    for (const q of reflect) expect(q.format).toBe('text')
  })

  it('reflection questions have no grading or correct_value', () => {
    for (const q of reflect) {
      expect(q.grading).toBeUndefined()
      expect(q.correct_value).toBeUndefined()
    }
  })
})
