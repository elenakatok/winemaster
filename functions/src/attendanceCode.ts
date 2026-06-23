import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from './engine/instructorAuth'
import { extractStudentIds } from './engine/studentAuth'

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

// Unambiguous uppercase chars: no I (→1), L (→1), O (→0).
const CODE_CHARS  = 'ABCDEFGHJKMNPQRTUVWXY'
const CODE_LENGTH = 5

function makeCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

async function doGenerateAttendanceCode(gameInstanceId: string): Promise<string> {
  const code = makeCode()
  await admin.firestore()
    .collection('game_instances').doc(gameInstanceId)
    .collection('attendance_code').doc('current')
    .set({ code, generated_at: FieldValue.serverTimestamp() })
  return code
}

async function doVerifyAttendanceCode(
  gameInstanceId: string,
  participantId: string,
  submittedCode: string,
): Promise<void> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)
  const codeRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('attendance_code').doc('current')

  const [participantSnap, codeSnap] = await Promise.all([
    participantRef.get(),
    codeRef.get(),
  ])

  if (!participantSnap.exists) {
    throw Object.assign(new Error('Participant not found.'), { status: 404 })
  }

  const pdata = participantSnap.data()!

  if (pdata.confirmed_ready_at == null) {
    throw Object.assign(
      new Error('Please complete the confirmation step first.'),
      { status: 400 },
    )
  }

  // Idempotent: already verified.
  if (pdata.attendance_confirmed_at != null) return

  if (!codeSnap.exists) {
    throw Object.assign(
      new Error('No attendance code has been generated yet. Ask your instructor to display one.'),
      { status: 400 },
    )
  }

  const storedCode = (codeSnap.data()!.code as string).toUpperCase()
  if (submittedCode.toUpperCase().trim() !== storedCode) {
    throw Object.assign(
      new Error("That code doesn't match. Check what your instructor is displaying and try again."),
      { status: 400 },
    )
  }

  await participantRef.update({
    attendance_confirmed_at: FieldValue.serverTimestamp(),
  })

  // Write to RTDB so the instructor dashboard shows a real-time attendance list.
  // This path is persistent (never deleted on disconnect).
  await admin.database()
    .ref(`attending/${gameInstanceId}/${participantId}`)
    .set({
      display_name: pdata.display_name ?? '',
      role:         pdata.role ?? '',
      confirmed_at: Date.now(),
    })
}

/**
 * Generates a new 5-char attendance code for a game instance and stores it.
 * Called by the instructor dashboard ("Show Code" action). Always overwrites.
 *
 * Request body (emulator): { _dev: { game_instance_id } }
 * Request body (production): { token: "<instructor JWT>" } or Bearer
 * Response: { ok: true, code: "ABCDE" }
 */
export const generateAttendanceCode = onRequest(async (req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const gameInstanceId = await extractInstructorGameId(body, isEmulator, res, req.headers.authorization)
  if (!gameInstanceId) return

  try {
    const code = await doGenerateAttendanceCode(gameInstanceId)
    res.json({ ok: true, code })
  } catch (err) {
    console.error('generateAttendanceCode error:', err)
    res.status(500).json({ error: 'Internal error' })
  }
})

/**
 * Verifies a student-submitted attendance code. On match:
 *   - Sets attendance_confirmed_at on the participant doc.
 *   - Writes RTDB attending/{gameInstanceId}/{participantId} = { display_name, role, confirmed_at }.
 *
 * Full gating: requires confirmed_ready_at to be set (confirmReady gate must run first).
 * Idempotent — re-calling after success is a no-op.
 *
 * Request body: { code: "ABCDE", token | _test }
 * Response: { ok: true }
 */
export const verifyAttendanceCode = onRequest(async (req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = req.body as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const ids = await extractStudentIds(body, isEmulator, res, req.headers.authorization)
  if (!ids) return
  const { participantId, gameInstanceId } = ids

  const code = body.code
  if (typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'code is required' })
    return
  }

  try {
    await doVerifyAttendanceCode(gameInstanceId, participantId, code)
    res.json({ ok: true })
  } catch (err) {
    const status  = (err as { status?: number }).status ?? 500
    const message = err instanceof Error ? err.message : 'Internal error'
    res.status(status).json({ error: message })
  }
})
