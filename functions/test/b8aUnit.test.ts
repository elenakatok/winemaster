/**
 * B8a unit tests — assignRole JWT verification path.
 *
 * Tests the classroom JWT verification logic without the emulator by using a
 * locally-generated RSA key pair. All role-balance and Firestore logic is
 * covered in b8aIntegration.cjs. This file focuses on the auth boundary.
 *
 * Run: npx vitest run test/b8aUnit.test.ts
 */

import { describe, it, expect } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import * as jwt from 'jsonwebtoken'
import { verifyClassroomToken } from '../src/engine/verifyToken'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

function signStudentToken(overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    participant_id:         'student-pid-001',
    name:                   'Test Student',
    course_id:              'course-abc',
    session_id:             'session-xyz',
    game_instance_id:       'inst-b8a-001',
    game_config_id:         'cfg-001',
    role:                   'student',
    classroom_callback_url: 'https://classroom.example.com/callback',
    callback_secret_id:     'winemaster_v1',
    sub:                    'student-pid-001',
    iss:                    'classroom.mygames.live',
    ...overrides,
  }
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: '1h',
    keyid:     'classroom-v1',
  })
}

describe('assignRole — classroom JWT verification', () => {
  it('accepts a valid student token and extracts participant_id + game_instance_id', () => {
    const token   = signStudentToken()
    const payload = verifyClassroomToken(token, publicKey as string)
    expect(payload.role).toBe('student')
    expect(payload.participant_id).toBe('student-pid-001')
    expect(payload.game_instance_id).toBe('inst-b8a-001')
  })

  it('extracts the correct game_instance_id across different instances', () => {
    const token   = signStudentToken({ game_instance_id: 'inst-different-999', participant_id: 'pid-999' })
    const payload = verifyClassroomToken(token, publicKey as string)
    expect(payload.game_instance_id).toBe('inst-different-999')
    expect(payload.participant_id).toBe('pid-999')
  })

  it('rejects a token signed with the wrong key', () => {
    const { privateKey: wrongKey } = generateKeyPairSync('rsa', {
      modulusLength:      2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const token = jwt.sign(
      { participant_id: 'p1', game_instance_id: 'inst1', role: 'student',
        iss: 'classroom.mygames.live', sub: 'p1' },
      wrongKey,
      { algorithm: 'RS256', expiresIn: '1h', keyid: 'classroom-v1' },
    )
    expect(() => verifyClassroomToken(token, publicKey as string)).toThrow()
  })

  it('rejects a token with a wrong kid', () => {
    const token = jwt.sign(
      { participant_id: 'p1', game_instance_id: 'inst1', role: 'student',
        iss: 'classroom.mygames.live', sub: 'p1' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '1h', keyid: 'wrong-kid' },
    )
    expect(() => verifyClassroomToken(token, publicKey as string)).toThrow(/Unexpected key id/)
  })

  it('rejects a token with a wrong issuer', () => {
    const token = jwt.sign(
      { participant_id: 'p1', game_instance_id: 'inst1', role: 'student',
        sub: 'p1' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '1h', keyid: 'classroom-v1',
        issuer: 'evil.example.com' },
    )
    expect(() => verifyClassroomToken(token, publicKey as string)).toThrow()
  })

  it('rejects an expired token', () => {
    const token = jwt.sign(
      { participant_id: 'p1', game_instance_id: 'inst1', role: 'student',
        iss: 'classroom.mygames.live', sub: 'p1' },
      privateKey,
      { algorithm: 'RS256', expiresIn: -1, keyid: 'classroom-v1' },
    )
    expect(() => verifyClassroomToken(token, publicKey as string)).toThrow()
  })

  it('instructor token is verifiable but role field is instructor (assignRole HTTP wrapper rejects it)', () => {
    // The HTTP wrapper (assignRole onRequest) enforces that the JWT is a student token.
    // verifyClassroomToken itself doesn't care about role — that check is in the wrapper.
    // This test documents the separation: JWT verify succeeds, role check is a layer above.
    const token   = signStudentToken({ role: 'instructor' })
    const payload = verifyClassroomToken(token, publicKey as string)
    expect(payload.role).toBe('instructor')
    // Caller would check payload.role !== 'student' and reject — not verifyClassroomToken's job.
  })
})

describe('roleKeys — Winemaster config', () => {
  it('returns exactly [winemaster, home_base] in declaration order', async () => {
    const { roleKeys } = await import('@mygames/game-engine')
    const { winemasterConfig } = await import('../src/gameDefinition')
    const keys = roleKeys(winemasterConfig)
    expect(keys).toEqual(['winemaster', 'home_base'])
  })
})
