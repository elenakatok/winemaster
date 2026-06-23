/**
 * B7a unit tests — classroom JWT verification path for getInstructorSession.
 *
 * These tests exercise verifyClassroomToken (the real JWT path) without the
 * emulator by using a locally-generated RSA key pair. The test key is passed
 * as the optional publicKey override to verifyClassroomToken, so the baked-in
 * classroom public key is bypassed — the cryptographic logic is identical.
 *
 * Run: npx vitest run test/b7aUnit.test.ts
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

function signTestToken(overrides: Record<string, unknown> = {}): string {
  const payload: Record<string, unknown> = {
    participant_id:          'test-participant',
    name:                    'Test Instructor',
    course_id:               'course-abc',
    session_id:              'session-xyz',
    game_instance_id:        'inst-test-001',
    game_config_id:          'cfg-001',
    role:                    'instructor',
    classroom_callback_url:  'https://classroom.example.com/callback',
    callback_secret_id:      'secret-id-1',
    sub:                     'test-participant',
    iss:                     'classroom.mygames.live',
    ...overrides,
  }
  return jwt.sign(payload, privateKey, {
    algorithm:  'RS256',
    expiresIn:  '1h',
    keyid:      'classroom-v1',
  })
}

describe('verifyClassroomToken — real JWT path', () => {
  it('accepts a valid instructor token and returns the payload', () => {
    const token = signTestToken()
    const payload = verifyClassroomToken(token, publicKey as string)
    expect(payload.role).toBe('instructor')
    expect(payload.game_instance_id).toBe('inst-test-001')
    expect(payload.name).toBe('Test Instructor')
  })

  it('accepts a valid student token (role extraction still works)', () => {
    const token = signTestToken({ role: 'student' })
    const payload = verifyClassroomToken(token, publicKey as string)
    expect(payload.role).toBe('student')
  })

  it('rejects a token with wrong kid', () => {
    const badToken = jwt.sign({ role: 'instructor', game_instance_id: 'x' }, privateKey, {
      algorithm: 'RS256',
      expiresIn: '1h',
      keyid:     'wrong-kid',
    })
    expect(() => verifyClassroomToken(badToken, publicKey as string)).toThrow()
  })

  it('rejects a token with wrong issuer', () => {
    const badToken = jwt.sign(
      { role: 'instructor', game_instance_id: 'x', sub: 'x' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '1h', keyid: 'classroom-v1', issuer: 'evil.example.com' }
    )
    expect(() => verifyClassroomToken(badToken, publicKey as string)).toThrow()
  })

  it('rejects an expired token', () => {
    const expired = jwt.sign(
      { role: 'instructor', game_instance_id: 'x', sub: 'x', iss: 'classroom.mygames.live' },
      privateKey,
      { algorithm: 'RS256', expiresIn: '-1s', keyid: 'classroom-v1' }
    )
    expect(() => verifyClassroomToken(expired, publicKey as string)).toThrow()
  })

  it('rejects a token signed with a different key', () => {
    const { privateKey: otherPrivKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const badToken = signTestToken()
    // Sign with test key but verify against wrong public key — should fail
    const { publicKey: otherPubKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    void otherPrivKey  // unused; we only need otherPubKey for the verify override
    expect(() => verifyClassroomToken(badToken, otherPubKey as string)).toThrow()
  })
})
