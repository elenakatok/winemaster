import { verifyClassroomToken, type ClassroomTokenPayload } from './verifyToken'
import { verifyFirebaseToken } from './verifyFirebaseToken'

type MinimalResponse = {
  status: (code: number) => { json: (body: object) => void }
}

/**
 * Extracts and validates the instructor's game_instance_id from an HTTP request.
 * Returns the game_instance_id on success, or null (after writing an error response) on failure.
 *
 * Auth paths (in order):
 *   1. Emulator dev bypass:    body._dev.game_instance_id  (FUNCTIONS_EMULATOR only)
 *   2. Firebase Bearer token:  Authorization: Bearer <instructor id token>
 *   3. Classroom JWT:          body.token  (RS256, role must be 'instructor')
 */
export async function extractInstructorGameId(
  body: Record<string, unknown>,
  isEmulator: boolean,
  res: MinimalResponse,
  authHeader?: string,
): Promise<string | null> {
  if (isEmulator && body._dev != null) {
    const dev = body._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      res.status(400).json({ error: '_dev requires game_instance_id' })
      return null
    }
    return dev.game_instance_id
  }
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { gameInstanceId, role } = await verifyFirebaseToken(authHeader)
      if (role !== 'instructor') {
        res.status(403).json({ error: 'Instructor access required' })
        return null
      }
      return gameInstanceId
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return null
    }
  }
  if (typeof body.token !== 'string') {
    res.status(400).json({ error: 'Missing token' })
    return null
  }
  let payload: ClassroomTokenPayload
  try {
    payload = verifyClassroomToken(body.token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    res.status(401).json({ error: message })
    return null
  }
  if (payload.role !== 'instructor') {
    res.status(403).json({ error: 'Instructor access required' })
    return null
  }
  return payload.game_instance_id
}
