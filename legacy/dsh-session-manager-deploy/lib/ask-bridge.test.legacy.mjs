// Tests for the delegated-ask bridge (`lib/ask-bridge.mjs`).
//
// The failure this pins, observed in a live deployment: a session delegated with
// `session_send(callback: true)` called `ask_user_question` and then did nothing
// for 107 minutes. The task itself was finished — the worker was parked inside
// one tool call that nobody could answer, because `ask_user_question` has no
// timeout and a delegated session is its own runtime root, so the seam's
// `DELEGATED_CALLER` guard does not cover it.
//
//   node package/lib/ask-bridge.test.mjs
//
// Exits non-zero when any check fails, so it works as a CI check.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ask-bridge-'))
process.env.DSH_HOME = dshHome

const bridgeUrl = new URL('./ask-bridge.mjs', import.meta.url)
const storeUrl = new URL('./store.mjs', import.meta.url)
const statePath = join(dshHome, 'session-manager', 'state.json')

const results = []
const check = (label, condition, detail) => {
  results.push([condition ? 'PASS' : 'FAIL', label, condition ? '' : ` => ${String(detail)}`])
}

const store = await import(storeUrl.href)
const bridge = await import(bridgeUrl.href)

const DELEGATOR = 'session-delegator-0001'
const WORKER = 'session-worker-0002'
const OTHER = 'session-other-0003'

/** Stand-in for the human UI answerer behind the bridge's own listener. */
const UI_ANSWER = { answers: [{ id: 'q1', selected: ['ui-answered'] }] }

/**
 * A promise that never settles: this is what the real chain looks like when no
 * browser is attached to the asking session. It is the production condition the
 * bridge exists to survive — the chain does not reject, it simply stays open.
 */
const never = () => new Promise(() => {})

/** Real-timer wait, captured before any test installs fake timers. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 20))

/** Poll until `predicate` holds, so a test never races an async file read. */
const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return true
    await new Promise((resolve) => realSetTimeout(resolve, 5))
  }
  check(`timed out waiting for ${label}`, false, 'never happened')
  return false
}

/** Forget every delegation, so one block cannot leak a pending row into the next. */
const resetLedger = async () => {
  const state = await store.readState()
  for (const row of state.delegations) await store.dropDelegation(row.id)
}

/**
 * Build a fresh fake Cordis context and apply the bridge to it.
 *
 * `uiMode` models what sits behind the bridge on the waterfall:
 *   'absent'      — the chain stays open forever (no browser on the session)
 *   'answers'     — a browser answers with UI_ANSWER
 *   'no-provider' — nothing is composed at all and the chain rejects
 */
const mount = (config = {}) => {
  const handlers = new Map()
  const prompted = []
  let failPrompt = false
  const uiMode = config.uiMode ?? 'absent'
  const controller = {
    prompt: async (request) => {
      // Model the real controller's `hasPromptRequest` dedupe: a retry carrying
      // the same requestId is observably a no-op, not a second delivery.
      if (prompted.some((row) => row.requestId === request.requestId)) return { accepted: true, deduped: true }
      if (failPrompt) throw new Error('delegator session is gone')
      prompted.push(request)
      return { accepted: true }
    },
  }
  const services = { sessionController: controller }
  if (config.noController === true) delete services.sessionController
  const ctx = {
    get: (serviceName) => services[serviceName],
    on: (eventName, listener, options) => {
      if (!handlers.has(eventName)) handlers.set(eventName, [])
      const list = handlers.get(eventName)
      if (options?.prepend === true) list.unshift(listener)
      else list.push(listener)
      return () => {}
    },
    effect: (factory) => {
      const disposer = factory()
      return () => {}
    },
  }
  bridge.apply(ctx, {
    ...(config.pluginConfig ?? {}),
    ...(config.uiGraceMs === undefined ? {} : { uiGraceMs: config.uiGraceMs }),
  })
  return {
    prompted,
    setFailPrompt: (value) => { failPrompt = value },
    /** Deliver one inbox insertion, as the real loop would. */
    insert: (agentId, text, source = { kind: 'user' }) => {
      for (const listener of handlers.get('agent/inbox/inserted') ?? []) {
        listener({ agent: { id: agentId }, message: { role: 'user', content: [{ type: 'text', text }], source } })
      }
    },
    /** Run the answerer waterfall: the bridge first, then whatever sits behind it. */
    ask: async (request) => {
      const list = [...(handlers.get('user-questions/request') ?? [])]
      const next = async () => {
        const listener = list.shift()
        if (listener === undefined) {
          if (uiMode === 'answers') return UI_ANSWER
          if (uiMode === 'no-provider') throw new Error('NO_PROVIDER')
          return never()
        }
        return listener(request, next)
      }
      return next()
    },
    requestedIds: () => prompted.map((row) => row.requestId),
  }
}

/** The common case: no browser on the worker, so the bridge forwards at once. */
const mountNoUi = (extra = {}) => mount({ uiMode: 'absent', uiGraceMs: 0, ...extra })

const delegate = (id, to, from = DELEGATOR, task = 'do the thing') =>
  store.addDelegation({ id, from, to, task, mode: 'queue', createdAt: Date.now(), baselineSeq: 0, status: 'pending' })

const question = (overrides = {}) => ({
  id: 'q1',
  question: 'Which mode should I use?',
  options: [
    { label: 'Fast (Recommended)', description: 'skips the slow path' },
    { label: 'Careful', description: 'verifies everything' },
  ],
  ...overrides,
})

/** Run a body with fake timers, capturing the callbacks the bridge scheduled. */
const withFakeTimers = async (body) => {
  const restoreSetTimeout = globalThis.setTimeout
  const restoreClearTimeout = globalThis.clearTimeout
  const scheduled = []
  globalThis.setTimeout = (callback) => { scheduled.push(callback); return { fake: true } }
  globalThis.clearTimeout = () => {}
  try {
    return await body(scheduled)
  } finally {
    globalThis.setTimeout = restoreSetTimeout
    globalThis.clearTimeout = restoreClearTimeout
  }
}

// ── ① a foreground question is never claimed: the human UI still answers ──────

{
  await resetLedger()
  const harness = mount({ uiMode: 'answers' })
  const answered = await harness.ask({ agent: { id: OTHER }, questions: [question()] })
  check('a question from an undelegated session reaches its own UI', answered === UI_ANSWER, JSON.stringify(answered))
  check('an undelegated question delivers no notice into any session', harness.prompted.length === 0, JSON.stringify(harness.prompted))
}

{
  // With nobody composed behind it at all, an undelegated question still fails
  // exactly as it did before this row existed.
  await resetLedger()
  const harness = mount({ uiMode: 'no-provider' })
  await harness.ask({ agent: { id: OTHER }, questions: [question()] }).then(
    () => check('an undelegated question with no UI still rejects', false, 'it resolved'),
    (error) => check('an undelegated question with no UI still rejects', String(error.message).includes('NO_PROVIDER'), String(error.message)),
  )
}

{
  // A pending delegation for someone ELSE must not make this agent claimable.
  await resetLedger()
  await delegate('dlg-other-target', OTHER)
  const harness = mount({ uiMode: 'answers' })
  const answered = await harness.ask({ agent: { id: WORKER }, questions: [question()] })
  check('the bridge claims only delegations targeting the asking agent', answered === UI_ANSWER, JSON.stringify(answered))
  check('a delegation targeting another session produces no notice', harness.prompted.length === 0, JSON.stringify(harness.prompted))
}

{
  // A browser watching the worker's OWN session answers first: unchanged behavior,
  // and the delegator is never bothered.
  await resetLedger()
  await delegate('dlg-ui-wins', WORKER)
  const harness = mount({ uiMode: 'answers', uiGraceMs: 0 })
  const answered = await harness.ask({ agent: { id: WORKER }, questions: [question()] })
  check('a browser on the worker session still answers its own question', answered === UI_ANSWER, JSON.stringify(answered))
  check('the own-session UI answer suppresses the delegator notice', harness.prompted.length === 0, JSON.stringify(harness.prompted))
}

{
  // A delegation that already settled is not a reason to claim.
  await resetLedger()
  await delegate('dlg-settled', WORKER)
  await store.settleDelegation('dlg-settled', { status: 'done', reply: 'finished', note: 'turn ended completed' })
  const harness = mount({ uiMode: 'no-provider' })
  await harness.ask({ agent: { id: WORKER }, questions: [question()] }).then(
    () => check('a settled delegation never claims a later question', false, 'it claimed'),
    (error) => check('a settled delegation never claims a later question', String(error.message).includes('NO_PROVIDER'), String(error.message)),
  )
  check('a settled delegation produces no notice', harness.prompted.length === 0, JSON.stringify(harness.prompted))
}

{
  await resetLedger()
  await delegate('dlg-no-controller', WORKER)
  const harness = mount({ noController: true, uiMode: 'no-provider' })
  await harness.ask({ agent: { id: WORKER }, questions: [question()] }).then(
    () => check('without a sessionController the question falls through', false, 'it claimed'),
    (error) => check('without a sessionController the question falls through', String(error.message).includes('NO_PROVIDER'), String(error.message)),
  )
}

{
  await resetLedger()
  await delegate('dlg-disabled', WORKER)
  const harness = mount({ pluginConfig: { timeoutMs: 0 }, uiMode: 'no-provider' })
  await harness.ask({ agent: { id: WORKER }, questions: [question()] }).then(
    () => check('timeoutMs: 0 disables claiming entirely', false, 'it claimed'),
    (error) => check('timeoutMs: 0 disables claiming entirely', String(error.message).includes('NO_PROVIDER'), String(error.message)),
  )
  check('timeoutMs: 0 delivers no notice', harness.prompted.length === 0, String(harness.prompted.length))
}

{
  // The UI grace defers the notice: with a long grace, nothing is forwarded yet.
  // Fake timers here because the point IS the open 60 s window; a real one would
  // keep the process alive after the suite finishes.
  await resetLedger()
  await delegate('dlg-grace', WORKER)
  await withFakeTimers(async (scheduled) => {
    const harness = mount({ uiMode: 'absent', uiGraceMs: 60000 })
    void harness.ask({ agent: { id: WORKER }, questions: [question()] }).catch(() => {})
    await waitFor(() => scheduled.length === 2, 'the grace and deadline timers')
    check('a long UI grace holds the notice back', harness.prompted.length === 0, String(harness.prompted.length))
    scheduled[1]() // release the open question on the deadline
    await tick()
  })
}

// ── ② a delegated question reaches the delegator, and its reply answers it ────

{
  await resetLedger()
  const harness = mountNoUi()
  await delegate('dlg-ask-1', WORKER)
  const pending = harness.ask({ agent: { id: WORKER }, questions: [question()] })

  let settledEarly = false
  pending.then(() => { settledEarly = true }, () => { settledEarly = true })
  await waitFor(() => harness.prompted.length === 1, 'the delegator notice')
  check('a handed-off question does not resolve before anyone replies', settledEarly === false, 'it settled early')

  check('exactly one notice is delivered into the delegator session', harness.prompted.length === 1, String(harness.prompted.length))
  const notice = harness.prompted[0]
  check('the notice targets the delegator session', notice.sessionId === DELEGATOR, String(notice.sessionId))
  check('the notice is queued, so it never interrupts the delegator', notice.mode === 'queue', String(notice.mode))
  const text = notice.content[0].text
  check('the notice carries the original question text', text.includes('Which mode should I use?'), text)
  check('the notice lists every option', text.includes('Fast (Recommended)') && text.includes('Careful'), text)
  check('the notice names the recommended default', text.includes('← 默认推荐'), text)
  check('the notice names the target session to reply to', text.includes(WORKER), text)
  check('the notice states the timeout fallback', text.includes('自动按「默认推荐」项继续'), text)
  check('the requestId is derived from the delegation id', notice.requestId.startsWith('preset-delegation-ask-dlg-ask-1-'), String(notice.requestId))
  check('the requestId does not collide with the settlement notice', !notice.requestId.startsWith('preset-delegation-dlg-ask-1'), String(notice.requestId))

  // The delegator replies with one ordinary session_send into the worker.
  harness.insert(WORKER, 'Careful')
  const answer = await pending
  check('the delegator reply becomes the answer', answer.answers[0].selected[0] === 'Careful', JSON.stringify(answer))
  check('an option-matching reply needs no custom text', answer.answers[0].custom === undefined, JSON.stringify(answer))

  const ledger = JSON.parse(await readFile(statePath, 'utf8')).delegations
  const row = ledger.find((item) => item.id === 'dlg-ask-1')
  check('the hand-off is recorded durably on the delegation', row.note.includes('提问已转交'), JSON.stringify(row.note))
}

{
  // A reply that names no option is passed through as free text.
  await resetLedger()
  const harness = mountNoUi()
  await delegate('dlg-ask-2', WORKER)
  const pending = harness.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitFor(() => harness.prompted.length === 1, 'the delegator notice')
  harness.insert(WORKER, 'neither, use the hybrid path')
  const answer = await pending
  check('a free-text reply becomes the custom answer', answer.answers[0].custom === 'neither, use the hybrid path', JSON.stringify(answer))
  check('a free-text reply selects no option', answer.answers[0].selected.length === 0, JSON.stringify(answer))
}

{
  // An assistant or plugin message is not the delegator's reply.
  await resetLedger()
  const harness = mountNoUi()
  await delegate('dlg-ask-3', WORKER)
  const pending = harness.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitFor(() => harness.prompted.length === 1, 'the delegator notice')
  harness.insert(WORKER, 'Careful', { kind: 'plugin', plugin: 'x' })
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  await tick()
  check('a non-user message does not answer the question', settled === false, 'it settled')
  harness.insert(WORKER, 'Careful')
  check('the real user reply then answers it', (await pending).answers[0].selected[0] === 'Careful', 'wrong answer')
}

{
  // A reply into a different session must not unblock this worker.
  await resetLedger()
  const harness = mountNoUi()
  await delegate('dlg-ask-3b', WORKER)
  const pending = harness.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitFor(() => harness.prompted.length === 1, 'the delegator notice')
  harness.insert(OTHER, 'Careful')
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  await tick()
  check("another session's message does not answer this worker's question", settled === false, 'it settled')
  harness.insert(WORKER, 'Careful')
  await pending
}

// ── ③ duplicate delivery is suppressed by the derived requestId ──────────────

{
  await resetLedger()
  const harness = mountNoUi()
  await delegate('dlg-ask-4', WORKER)
  const first = harness.ask({ agent: { id: WORKER }, questions: [question()] })
  const second = harness.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitFor(() => harness.prompted.length === 1, 'the deduped notice')
  await tick()
  check('two identical questions reuse one derived requestId', new Set(harness.requestedIds()).size === 1, JSON.stringify(harness.requestedIds()))
  check('the deduped second question delivers no extra prompt', harness.prompted.length === 1, String(harness.prompted.length))
  harness.insert(WORKER, 'Careful')
  const [a] = await Promise.all([first, second])
  check('both concurrent questions resolve together', a.answers[0].selected[0] === 'Careful', JSON.stringify(a))
}

{
  // A genuinely different question must still get through.
  await resetLedger()
  const harness = mountNoUi()
  await delegate('dlg-ask-5', WORKER)
  const first = harness.ask({ agent: { id: WORKER }, questions: [question()] })
  await waitFor(() => harness.prompted.length === 1, 'the first notice')
  harness.insert(WORKER, 'Careful')
  await first
  const second = harness.ask({ agent: { id: WORKER }, questions: [question({ id: 'q2', question: 'And now?' })] })
  await waitFor(() => harness.prompted.length === 2, 'the second notice')
  check('a different question produces its own requestId', new Set(harness.requestedIds()).size === 2, JSON.stringify(harness.requestedIds()))
  harness.insert(WORKER, 'Careful')
  await second
}

// ── ④ no permanent block: failures and timeouts always release the worker ────

{
  await resetLedger()
  await delegate('dlg-ask-6', WORKER)
  await withFakeTimers(async (scheduled) => {
    const harness = mountNoUi()
    const pending = harness.ask({ agent: { id: WORKER }, questions: [question()] })
    // The listener reads the durable ledger before it schedules anything, so wait
    // for that real async read even though the timers themselves are fake.
    await waitFor(() => scheduled.length === 2, 'the grace and deadline timers')
    check('a handed-off question schedules a grace and a deadline', scheduled.length === 2, String(scheduled.length))
    scheduled[0]() // the UI grace expires
    await tick()
    check('the notice goes out once the grace expires', harness.prompted.length === 1, String(harness.prompted.length))
    scheduled[1]() // the delegator window expires
    const answer = await pending
    check('on timeout the worker gets the recommended option', answer.answers[0].selected[0] === 'Fast (Recommended)', JSON.stringify(answer))
    const ledger = JSON.parse(await readFile(statePath, 'utf8')).delegations
    const row = ledger.find((item) => item.id === 'dlg-ask-6')
    check('the timeout is recorded in the delegation note', row.note.includes('无答复'), JSON.stringify(row.note))
  })
}

{
  // No options at all: the worker still proceeds, with an explicit assumption note.
  await resetLedger()
  await delegate('dlg-ask-7', WORKER)
  await withFakeTimers(async (scheduled) => {
    const harness = mountNoUi()
    const pending = harness.ask({ agent: { id: WORKER }, questions: [question({ options: undefined, multi_select: undefined })] })
    await waitFor(() => scheduled.length === 2, 'the grace and deadline timers')
    scheduled[0]()
    await tick()
    scheduled[1]()
    const answer = await pending
    check(
      'an optionless timeout selects nothing and states the assumption',
      answer.answers[0].selected.length === 0 && /无人作答/.test(answer.answers[0].custom),
      JSON.stringify(answer),
    )
  })
}

{
  // An aborted turn must reject exactly like the real seam, never answer.
  await resetLedger()
  await delegate('dlg-ask-7b', WORKER)
  await withFakeTimers(async () => {
    const harness = mountNoUi()
    const controller = new AbortController()
    const pending = harness.ask({ agent: { id: WORKER }, questions: [question()], signal: controller.signal })
    let rejected = null
    pending.catch((error) => { rejected = error })
    controller.abort()
    await tick()
    check('an aborted question rejects rather than answering', rejected !== null, 'it did not reject')
    check('the abort rejection explains itself', String(rejected?.message).includes('aborted'), String(rejected?.message))
  })
}

{
  await resetLedger()
  await delegate('dlg-ask-8', WORKER)
  const harness = mountNoUi()
  harness.setFailPrompt(true)
  const answer = await harness.ask({ agent: { id: WORKER }, questions: [question()] })
  check('an undeliverable notice releases the worker immediately', answer.answers[0].selected[0] === 'Fast (Recommended)', JSON.stringify(answer))
  const ledger = JSON.parse(await readFile(statePath, 'utf8')).delegations
  const row = ledger.find((item) => item.id === 'dlg-ask-8')
  check('the undeliverable notice is recorded', row.note.includes('提问转交失败'), JSON.stringify(row.note))
}

// ── pure helpers ─────────────────────────────────────────────────────────────

check('the delegator window sits in the sanctioned 2–5 minute band', bridge.DEFAULT_TIMEOUT_MS >= 120000 && bridge.DEFAULT_TIMEOUT_MS <= 300000, String(bridge.DEFAULT_TIMEOUT_MS))
check('the UI grace is shorter than the delegator window', bridge.DEFAULT_UI_GRACE_MS < bridge.DEFAULT_TIMEOUT_MS, String(bridge.DEFAULT_UI_GRACE_MS))
check('resolveTimeoutMs defaults when unset', bridge.resolveTimeoutMs(undefined) === bridge.DEFAULT_TIMEOUT_MS, String(bridge.resolveTimeoutMs(undefined)))
check('resolveTimeoutMs floors an absurdly small value', bridge.resolveTimeoutMs(1) === bridge.MIN_TIMEOUT_MS, String(bridge.resolveTimeoutMs(1)))
check('resolveTimeoutMs caps an absurdly large value', bridge.resolveTimeoutMs(99999999) === bridge.MAX_TIMEOUT_MS, String(bridge.resolveTimeoutMs(99999999)))
check('resolveTimeoutMs treats a negative value as misconfiguration', bridge.resolveTimeoutMs(-5) === bridge.DEFAULT_TIMEOUT_MS, String(bridge.resolveTimeoutMs(-5)))
check('resolveTimeoutMs honours 0 as an explicit opt-out', bridge.resolveTimeoutMs(0) === 0, String(bridge.resolveTimeoutMs(0)))
check('resolveUiGraceMs defaults when unset', bridge.resolveUiGraceMs(undefined) === bridge.DEFAULT_UI_GRACE_MS, String(bridge.resolveUiGraceMs(undefined)))
check('resolveUiGraceMs caps an absurdly large value', bridge.resolveUiGraceMs(99999999) === bridge.MAX_UI_GRACE_MS, String(bridge.resolveUiGraceMs(99999999)))
check('describeWindow reports minutes for a minute-scale window', bridge.describeWindow(180000) === '3 分钟', String(bridge.describeWindow(180000)))
check('describeWindow never rounds a real wait down to 0 分钟', bridge.describeWindow(15000) === '15 秒', String(bridge.describeWindow(15000)))
check('recommendedLabel prefers the caller-tagged recommendation', bridge.recommendedLabel(question()) === 'Fast (Recommended)', String(bridge.recommendedLabel(question())))
check('recommendedLabel accepts a Chinese recommendation tag', bridge.recommendedLabel({ options: [{ label: '快' }, { label: '稳（推荐）' }] }) === '稳（推荐）', 'not the tagged option')
check('recommendedLabel falls back to the first option', bridge.recommendedLabel({ options: [{ label: 'A' }, { label: 'B' }] }) === 'A', 'not A')
check('recommendedLabel is null without options', bridge.recommendedLabel({}) === null, 'not null')
check('the question digest is stable', bridge.questionDigest([question()]) === bridge.questionDigest([question()]), 'unstable')
// Option order is part of the identity: the first option is the fallback default
// when no option is tagged, so a reordering is a genuinely different question.
check('the question digest tracks option order', bridge.questionDigest([question()]) !== bridge.questionDigest([question({ options: [{ label: 'Careful' }, { label: 'Fast (Recommended)' }] })]), 'order-insensitive')
check('the question digest changes with the question text', bridge.questionDigest([question()]) !== bridge.questionDigest([question({ question: 'Something else?' })]), 'collision')
check('answersFromReply matches an exact option label', bridge.answersFromReply('Careful', [question()]).answers[0].selected[0] === 'Careful', 'no match')
check('answersFromReply is case-insensitive', bridge.answersFromReply('careful', [question()]).answers[0].selected[0] === 'Careful', 'no match')
check('answersFromReply passes unknown text through as custom', bridge.answersFromReply('nope', [question()]).answers[0].custom === 'nope', 'lost the text')

// ── report ───────────────────────────────────────────────────────────────────

const failed = results.filter(([status]) => status === 'FAIL')
for (const [status, label, detail] of results) {
  if (status === 'FAIL') console.log(`FAIL ${label}${detail}`)
}
console.log(`${String(results.length - failed.length)}/${String(results.length)} passed`)
await rm(dshHome, { recursive: true, force: true })
if (failed.length > 0) process.exit(1)
