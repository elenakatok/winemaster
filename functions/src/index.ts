import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeTriggerMatching,
  makeSubmitLeadOutcome,
  makeSubmitConfirmation,
  makeFinalizeInstance,
  makePushResultsToClassroom,
  makeGetGameConfig,
  makeUpdateGameConfig,
  validateKCGate,
  makeGetStudentPrepQuestions,
  makeSubmitKnowledgeCheck,
  makeSubmitStaticKnowledgeCheckQuestion,
} from '@mygames/game-server'
import { winemasterGameDef } from './gameDefinition'

admin.initializeApp()

// ── KC gate validation (runs at cold start — loud failure if gate is misconfigured) ──
const _kcGateError = validateKCGate(
  winemasterGameDef.roles.roles.map(r => r.key),
  winemasterGameDef.prepDefaults ?? [],
)
if (_kcGateError) throw new Error(`Winemaster KC gate validation failed: ${_kcGateError}`)

// ── Game endpoints (onCall, via game-server factories + Winemaster definition) ─

export const getInstructorSession  = makeGetInstructorSession(winemasterGameDef)
export const assignRole             = makeAssignRole(winemasterGameDef)
export const completePrep           = makeCompletePrep(winemasterGameDef)
export const confirmReady           = makeConfirmReady(winemasterGameDef)
export const generateAttendanceCode = makeGenerateAttendanceCode(winemasterGameDef)
export const verifyAttendanceCode   = makeVerifyAttendanceCode(winemasterGameDef)
export const getRoster              = makeGetRoster(winemasterGameDef)
export const syncRoster             = makeSyncRoster(winemasterGameDef)
export const triggerMatching        = makeTriggerMatching(winemasterGameDef)
export const submitLeadOutcome      = makeSubmitLeadOutcome(winemasterGameDef)
export const submitConfirmation     = makeSubmitConfirmation(winemasterGameDef)
export const finalizeInstance       = makeFinalizeInstance(winemasterGameDef)
export const pushResultsToClassroom = makePushResultsToClassroom(winemasterGameDef)
export const getGameConfig          = makeGetGameConfig(winemasterGameDef)
export const updateGameConfig       = makeUpdateGameConfig(winemasterGameDef)
export const getStudentPrepQuestions          = makeGetStudentPrepQuestions(winemasterGameDef)
export const submitKnowledgeCheck             = makeSubmitKnowledgeCheck(winemasterGameDef)
export const submitStaticKnowledgeCheckQuestion = makeSubmitStaticKnowledgeCheckQuestion(winemasterGameDef)

// ── Non-game onRequest endpoints (kept as-is; not converted) ──────────────────

const CORS_ORIGINS = new Set(['https://winemaster.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'winemaster' })
})

// Emulator-only dev seed functions — onRequest, not game endpoints.
export { seedMatchTest, seedGroupForTest } from './seedFunctions'
