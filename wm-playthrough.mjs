/**
 * Winemaster production play-through — 8 students, 2 groups
 *
 * Drives all 8 through Phase 1 (info → KC → prep → hold → attendance code →
 * waiting room), STOPs for instructor "Match Now", then drives Phase 2
 * (group reveal → off-platform → outcome reporting → results).
 *
 * Run from this directory (grays-com/frontend where playwright is installed):
 *   node wm-playthrough.mjs
 */

import { chromium }    from 'playwright'
import { execSync }    from 'child_process'
import { readFileSync } from 'fs'
import * as readline   from 'readline'

// ── Constants ─────────────────────────────────────────────────────────────────

const GAME_INSTANCE_ID = 'pqDhWBU67CaL9bXWMPvy'
const COURSE_ID        = 'BmWLnpW7UCvO66qvDgaq'
const SESSION_ID       = 'jcWbfsekOQGWGwB4p5cA'
const COURSE_CODE      = 'ABC'
const CLASSROOM_BASE   = 'https://us-central1-mygames-classroom-aec1b.cloudfunctions.net'
const WM_PROJECT       = 'winemaster-mygames-live'
const FIRESTORE_REST   = `https://firestore.googleapis.com/v1/projects/${WM_PROJECT}/databases/(default)/documents`

const STUDENTS = [
  { participant_id: '2ev2Xa7BpgOMqheQFO2X', login_code: 'VEE9NJ' },
  { participant_id: '5pofCNMkVdttDN53dsEg', login_code: 'LKD5AZ' },
  { participant_id: '8ntwB6vk2c8kbp7IBGr2', login_code: 'E5B7SN' },
  { participant_id: 'EVSY9fWRnL6s6KnmtCqP', login_code: '504CEB' },
  { participant_id: 'iU1IQP8bDhA2ON6fsxqw', login_code: 'HJRUFK' },
  { participant_id: 'kOFGof8mO65xBk0RCzRb', login_code: '0P82ST' },
  { participant_id: 'lPKNae5xJL9npPFwWCZD', login_code: '4YYIN4' },
  { participant_id: 'nOJAXoNEySyekXfnwX6T', login_code: '8QLD91' },
]

// ── KC answers keyed by visible radio-label text ──────────────────────────────

const KC_ANSWERS = {
  winemaster: {
    gate: 'WineMaster — co-founder, one-third owner, and senior manager of the company being sold',
    static: [
      'Scarcity',
      'Reciprocation',
      'It reframes the issue as a joint search for a fair standard rather than a contest of wills',
      'Decline to link the issues and insist each be settled on its own merits and relevant standard',
    ],
  },
  home_base: {
    gate: 'HomeBase — member of the business development team acquiring an online wine vendor',
    static: [
      'Scarcity',
      'Consistency',
      'Ask how they derived it, then treat the question as a joint search for the fairest standard',
      'Treat trust as a separate matter and settle the liability on its merits and the relevant standard',
    ],
  },
}

const PREP_ANSWERS = {
  winemaster: [
    'My BATNA is to continue operating WineMaster independently. We have a profitable business and can walk away from an unfavorable deal.',
    'Industry acquisition multiples, comparable SaaS valuations, and market norms for board seat inclusion in acquisitions.',
    'Most vulnerable to liking — a friendly HomeBase team. I will anchor every concession to objective criteria rather than the relationship.',
  ],
  home_base: [
    'My BATNA is to acquire a competing wine-tech vendor or build the capability in-house. We have real alternatives.',
    'Comparable acquisition price-to-revenue multiples, standard liability caps in M&A, and industry norms for vesting schedules.',
    'Most vulnerable to scarcity — artificial urgency. I will set a clear timeline and not let time pressure move me off the numbers.',
  ],
}

// Group 1 deal — positive surplus for both (S=160k, Pro Rata, no seat, L=300k)
const G1_OUTCOME = { shares: 160_000, vesting: 'Pro Rata', board_seat: false, liability: 300_000 }

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep  = ms => new Promise(r => setTimeout(r, ms))
const log    = (n, msg) => console.log(`[S${String(n).padStart(2,'0')}] ${msg}`)
const banner = msg => console.log('\n' + '─'.repeat(62) + '\n' + msg + '\n' + '─'.repeat(62))

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, () => { rl.close(); resolve() })
  })
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function getAccessToken() {
  try {
    const t = execSync('gcloud auth print-access-token 2>/dev/null', { timeout: 8000 }).toString().trim()
    if (t?.length > 20) return t
  } catch { /* fall through */ }
  const cfg = JSON.parse(readFileSync('/Users/emk120030/.config/configstore/firebase-tools.json', 'utf8'))
  return cfg.tokens.access_token
}

// ── Firestore REST helpers ────────────────────────────────────────────────────

async function fsGet(path) {
  const res = await fetch(`${FIRESTORE_REST}/${path}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  })
  if (!res.ok) return null
  return res.json()
}

async function fsGetDocs(path) {
  const res = await fetch(`${FIRESTORE_REST}/${path}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  })
  if (!res.ok) return []
  return (await res.json()).documents ?? []
}

async function pollAttendanceCode(maxMs = 300_000) {
  const start = Date.now()
  let warned  = false
  while (Date.now() - start < maxMs) {
    const doc  = await fsGet(`game_instances/${GAME_INSTANCE_ID}/attendance_code/current`)
    const code = doc?.fields?.code?.stringValue
    if (code) { console.log(`  Attendance code: ${code}`); return code }
    if (!warned) { console.log('  ⏳ Waiting for attendance code on dashboard...'); warned = true }
    await sleep(4000)
  }
  throw new Error('Timed out waiting for attendance code (5 min)')
}

async function readGroupCompositions() {
  const docs   = await fsGetDocs(`game_instances/${GAME_INSTANCE_ID}/groups`)
  const groups = {}
  for (const doc of docs) {
    const gid    = doc.name.split('/').pop()
    const f      = doc.fields ?? {}
    const wmPids = (f.winemaster_participants?.arrayValue?.values ?? []).map(v => v.stringValue)
    const hbPids = (f.home_base_participants?.arrayValue?.values ?? []).map(v => v.stringValue)
    const lead   = f.lead_participant_id?.stringValue ?? ''
    groups[gid]  = { pids: [...wmPids, ...hbPids], lead }
  }
  return groups
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function postJson(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

// ── Token fetch ───────────────────────────────────────────────────────────────

async function fetchStudentToken(student) {
  const loginData = await postJson(`${CLASSROOM_BASE}/loginStudent`, {
    course_code: COURSE_CODE,
    login_code:  student.login_code,
  })
  const participantId = loginData.participant_id ?? student.participant_id

  const tokenData = await postJson(`${CLASSROOM_BASE}/generateStudentToken`, {
    course_id:        COURSE_ID,
    participant_id:   participantId,
    login_code:       student.login_code,
    game_instance_id: GAME_INSTANCE_ID,
    session_id:       SESSION_ID,
  })
  return {
    token:          tokenData.token,
    game_url:       tokenData.game_url ?? 'https://winemaster.mygames.live',
    participant_id: participantId,
  }
}

// ── Phase 1a: info → KC → prep → hold screen ─────────────────────────────────

async function driveInfoPage(page, n) {
  await page.waitForSelector('p:has-text("Your role")', { timeout: 60_000 })
  const h1Text = (await page.locator('h1').first().textContent()) ?? ''
  const role   = h1Text.toLowerCase().includes('home') ? 'home_base' : 'winemaster'
  log(n, `info: ${h1Text} (${role}) → Continue`)
  await page.click('button:has-text("Continue")')
  return role
}

async function driveKC(page, n, role) {
  const answers = KC_ANSWERS[role]

  // Gate question
  await page.waitForSelector('text=What is your role in this negotiation?', { timeout: 30_000 })
  log(n, 'KC gate')
  await page.getByRole('radio', { name: answers.gate, exact: true }).click()
  await page.click('button:has-text("Submit")')
  if (await page.locator("text=That's not right").isVisible({ timeout: 3000 }).catch(() => false))
    throw new Error(`KC gate wrong answer for ${role}`)

  // 4 static questions
  for (let i = 0; i < answers.static.length; i++) {
    const isLast = i === answers.static.length - 1
    await page.waitForSelector('p:has-text("Concept check —")', { timeout: 20_000 })
    log(n, `KC static ${i+1}/4`)
    await page.getByRole('radio', { name: answers.static[i], exact: true }).click()
    await page.click('button:has-text("Submit")')
    await page.waitForSelector('text=✓ Correct', { timeout: 15_000 })
    await page.click(`button:has-text("${isLast ? 'Finish' : 'Continue'}")`)
  }
  log(n, 'KC ✓')
}

async function drivePrep(page, n, role) {
  for (let i = 0; i < PREP_ANSWERS[role].length; i++) {
    const isLast = i === PREP_ANSWERS[role].length - 1
    await page.waitForSelector('p:has-text("Preparation —")', { timeout: 20_000 })
    log(n, `Prep ${i+1}/${PREP_ANSWERS[role].length}`)
    await page.locator('textarea').fill(PREP_ANSWERS[role][i])
    await page.click(`button:has-text("${isLast ? 'Complete' : 'Continue'}")`)
  }
  log(n, 'Prep ✓')
}

async function driveToPrepComplete(browser, tokenData, n) {
  const ctx  = await browser.newContext()
  const page = await ctx.newPage()
  page.setDefaultTimeout(90_000)
  try {
    log(n, 'navigating')
    await page.goto(`${tokenData.game_url}?token=${tokenData.token}`)
    const role = await driveInfoPage(page, n)
    await driveKC(page, n, role)
    await drivePrep(page, n, role)
    await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 20_000 })
    log(n, '◆ hold screen')
    return { ctx, page, role, participantId: tokenData.participant_id, n }
  } catch (err) {
    log(n, `ERROR: ${err.message}`)
    await ctx.close()
    throw err
  }
}

// ── Phase 1b: hold → confirmation → attendance code → waiting room ────────────

async function driveToWaitingRoom(s, attendanceCode) {
  const { page, n } = s
  await page.waitForSelector('h1:has-text("Preparation complete")', { timeout: 5000 })
  log(n, 'hold → clicking "I\'m in class"')
  await page.click('button:has-text("in class")')

  await page.waitForSelector('h1:has-text("Ready to negotiate?")', { timeout: 20_000 })
  log(n, 'confirmation → "Yes, I\'m ready"')
  await page.click("button:has-text(\"Yes, I'm ready\")")

  await page.waitForSelector('h1:has-text("Enter attendance code")', { timeout: 20_000 })
  log(n, `attendance code → ${attendanceCode}`)
  await page.locator('input').fill(attendanceCode)
  await page.click('button[type="submit"]')

  await page.waitForSelector('h1:has-text("Waiting to be matched")', { timeout: 30_000 })
  log(n, '★ WAITING ROOM')
}

// ── Phase 2 ───────────────────────────────────────────────────────────────────

async function drivePhase2(students) {
  const pidMap = {}
  for (const s of students) pidMap[s.participantId] = s

  // ── Flip 1: waiting room → group reveal ────────────────────────────────────
  banner('FLIP 1: waiting room → group reveal (triggered by Match Now)')
  await Promise.all(students.map(async s => {
    await s.page.waitForSelector('h1:has-text("Your negotiation group")', { timeout: 120_000 })
    log(s.n, 'FLIP 1 ✓ — group reveal')
  }))
  console.log('All 8 on group reveal ✓')

  // Read group composition from Firestore
  await sleep(2000)
  const groups = await readGroupCompositions()
  console.log('\nGroup composition:')
  for (const [gid, { pids, lead }] of Object.entries(groups)) {
    console.log(`  ${gid}: [${pids.join(', ')}]  lead: ${lead}`)
  }

  // Verify 2+2 role split per group
  for (const [gid, { pids }] of Object.entries(groups)) {
    const groupStudents = pids.map(pid => pidMap[pid]).filter(Boolean)
    const wmCount = groupStudents.filter(s => s.role === 'winemaster').length
    const hbCount = groupStudents.filter(s => s.role === 'home_base').length
    console.log(`  ${gid}: ${wmCount} winemaster + ${hbCount} home_base ${wmCount===2&&hbCount===2?'✓':'⚠ MISMATCH'}`)
  }

  // ── Flip 2: one click → others auto-advance from group reveal ─────────────
  banner('FLIP 2: one "Start negotiation" click → others in same group auto-flip')
  for (const [gid, { pids }] of Object.entries(groups)) {
    const groupStudents = pids.map(pid => pidMap[pid]).filter(Boolean)
    if (groupStudents.length === 0) continue

    // First student in group clicks "Start negotiation"
    const clicker = groupStudents[0]
    log(clicker.n, `clicking Start negotiation (group ${gid})`)
    await clicker.page.click('button:has-text("Start negotiation")')
    await clicker.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 20_000 })
    log(clicker.n, 'off-platform ✓')

    // Remaining group members: check if they auto-flipped (Flip 2)
    for (const s of groupStudents.slice(1)) {
      const flipped = await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 15_000 })
        .then(() => true).catch(() => false)
      if (flipped) {
        log(s.n, 'FLIP 2 ✓ — auto-advanced without clicking')
      } else {
        log(s.n, 'FLIP 2 — not auto-flipped; clicking manually')
        await s.page.click('button:has-text("Start negotiation")')
        await s.page.waitForSelector('h1:has-text("Go negotiate")', { timeout: 15_000 })
      }
    }
  }

  // ── Outcome reporting for both groups ─────────────────────────────────────
  banner('Outcome reporting — G1 deal, G2 no-deal')
  const groupEntries = Object.entries(groups)
  await Promise.all(groupEntries.map(async ([gid, { pids, lead: leadPid }], gi) => {
    const groupStudents = pids.map(pid => pidMap[pid]).filter(Boolean)
    if (groupStudents.length === 0) return

    // Identify lead (use leadPid from Firestore; fall back to first)
    const leadS    = pidMap[leadPid] ?? groupStudents[0]
    const nonLeads = groupStudents.filter(s => s !== leadS)

    // Lead clicks "We've finished"
    log(leadS.n, `G${gi+1} — clicking "We've finished"`)
    await leadS.page.click("button:has-text(\"We've finished\")")

    // Non-leads may still be on off-platform — click their button too
    await Promise.all(nonLeads.map(async s => {
      const onOff = await s.page.locator('h1:has-text("Go negotiate")').isVisible({ timeout: 2000 }).catch(() => false)
      if (onOff) {
        log(s.n, `G${gi+1} — clicking "We've finished"`)
        await s.page.click("button:has-text(\"We've finished\")")
      }
    }))

    // Wait for lead to reach "Report outcome"
    await leadS.page.waitForSelector('h1:has-text("Report outcome")', { timeout: 30_000 })
    log(leadS.n, `G${gi+1} — Report outcome form`)

    // Non-leads should be on "Waiting for the outcome" (Flip 3 will fire after lead submits)
    await Promise.all(nonLeads.map(async s => {
      await s.page.waitForSelector('h1:has-text("Waiting for the outcome")', { timeout: 20_000 })
      log(s.n, `G${gi+1} — waiting for outcome`)
    }))

    if (gi === 0) {
      // Group 1: real deal
      log(leadS.n, `G1 filling outcome: shares=${G1_OUTCOME.shares} vesting=${G1_OUTCOME.vesting} board=${G1_OUTCOME.board_seat} liab=${G1_OUTCOME.liability}`)
      const numInputs = leadS.page.locator('input[type="number"]')
      await numInputs.nth(0).fill(String(G1_OUTCOME.shares))
      await leadS.page.selectOption('select', G1_OUTCOME.vesting)
      const cb = leadS.page.locator('input[type="checkbox"]')
      if (G1_OUTCOME.board_seat !== await cb.isChecked()) await cb.click()
      await numInputs.nth(1).fill(String(G1_OUTCOME.liability))
      await leadS.page.click('button:has-text("Review & submit")')
      await leadS.page.waitForSelector('h1:has-text("Confirm outcome")', { timeout: 10_000 })
      await leadS.page.click('button:has-text("Yes, submit")')
      log(leadS.n, 'G1 outcome submitted — waiting for group confirmation')
    } else {
      // Group 2: no deal
      log(leadS.n, 'G2 — no deal')
      await leadS.page.click('button:has-text("No deal")')
      await leadS.page.click('button:has-text("Yes, no deal")')
      log(leadS.n, 'G2 no deal submitted')
    }

    // Flip 3: non-leads auto-advance from "Waiting for the outcome" → "Confirm the outcome"
    await Promise.all(nonLeads.map(async s => {
      await s.page.waitForSelector('h1:has-text("Confirm")', { timeout: 30_000 })
      log(s.n, `FLIP 3 ✓ — auto-advanced to Confirm screen`)
      await s.page.click('button:has-text("Confirm")')
      log(s.n, 'confirmed')
    }))

    // Lead waits for results
    await leadS.page.waitForSelector('h1', { timeout: 30_000 })
    const h1 = await leadS.page.locator('h1').first().textContent()
    log(leadS.n, `G${gi+1} final screen: ${h1}`)
  }))
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  banner('Winemaster Production Play-Through — 8 students, 2 groups')
  console.log(`Instance: ${GAME_INSTANCE_ID}  Course: ${COURSE_ID}  Session: ${SESSION_ID}\n`)

  // 1. Fetch all 8 tokens in one tight batch
  console.log('Fetching 8 tokens...')
  const tokenData = await Promise.all(
    STUDENTS.map((s, i) => fetchStudentToken(s).then(d => { log(i+1, 'token OK'); return d }))
  )
  console.log('All 8 tokens fetched.\n')

  // 2. Launch browser (visible — 8 windows)
  const browser = await chromium.launch({ headless: false, slowMo: 80 })

  // 3. Phase 1a: info → KC → prep (stop at hold screen)
  console.log('Phase 1a: info → KC → prep (concurrent across all 8)...\n')
  let students
  try {
    students = await Promise.all(tokenData.map((td, i) => driveToPrepComplete(browser, td, i+1)))
  } catch (err) {
    console.error('Phase 1a failed:', err.message)
    await browser.close()
    process.exit(1)
  }

  // Summarise roles
  const wmCount = students.filter(s => s.role === 'winemaster').length
  const hbCount = students.filter(s => s.role === 'home_base').length

  banner(`ALL 8 ON HOLD SCREEN  (${wmCount} winemaster, ${hbCount} home_base)`)
  console.log('>>> Generate the attendance code on your instructor dashboard.')
  console.log('    Script polls Firestore and will proceed automatically.\n')

  // 4. Poll for attendance code (instructor generates it on the dashboard)
  const attendanceCode = await pollAttendanceCode()

  // 5. Phase 1b: hold → confirmation → attendance code → waiting room
  console.log('\nPhase 1b: driving to waiting room...\n')
  await Promise.all(students.map(s => driveToWaitingRoom(s, attendanceCode)))

  banner('ALL 8 IN THE WAITING ROOM ✓')
  students.forEach(s => log(s.n, `role: ${s.role}`))
  console.log('\n>>> STOP — Click "Match Now" on the instructor dashboard.')
  console.log('    Then press Enter here and Phase 2 will begin automatically.')

  await waitForEnter('\nPress Enter after clicking Match Now: ')

  // 6. Phase 2: group reveal → off-platform → outcome → results
  await drivePhase2(students)

  banner('BOTH GROUPS COMPLETED ✓')
  console.log('>>> STOP — Click "Finalize" then "Push to gradebook" on the dashboard.')
  console.log('    All 8 student screens should show their Results.\n')

  await waitForEnter('Press Enter to close all windows: ')
  await browser.close()
  console.log('Done.')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
