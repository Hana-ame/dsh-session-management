// Real-runtime integration test for the delegated-ask bridge.
//
// The unit test (`lib/ask-bridge.test.mjs`) verifies the bridge's decisions with a
// fake context. This one instead drives the REAL `@deepseek-ai/cordis` event
// machinery, so the things a fake context cannot prove are actually proven:
//
//   1. `ctx.on('user-questions/request', listener, { prepend: true })` is accepted
//      by the real registry and runs BEFORE a listener registered later — which is
//      what lets the bridge decide before api-remotes parks the request on an
//      absent browser.
//   2. Returning an answer from that listener really does resolve a real
//      `ctx.waterfall(...)` call, and calling `next()` really does reach the
//      listener behind it.
//   3. The durability path is real: the hand-off marker is written into the real
//      on-disk ledger by the real store module.
//
//   node package/test/ask-bridge.integration.test.mjs
//
// Exits non-zero when any check fails, so it works as a CI check.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ask-bridge-live-'))
process.env.DSH_HOME = dshHome

/**
 * Resolve a real harness package without depending on where this test is run
 * from. `tools.test.mjs` and the siblings import no bare packages at all; this
 * test needs the real Cordis runtime, so it locates the harness install that owns
 * `dsh-agent-presets` and resolves the package against it.
 */
const harnessModule = (specifier) => {
  const candidates = [
    process.env.DSH_HARNESS_MODULES,
    join(dirname(fileURLToPath(import.meta.url)), '../../node_modules'),
    '/home/lumin/.nvm/versions/node/v22.23.1/lib/node_modules/@deepseek-ai/dsh/node_modules',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const base of candidates) {
    const candidate = join(base, specifier, 'lib/index.js')
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }
  throw new Error(`cannot locate harness package ${specifier}; set DSH_HARNESS_MODULES to the harness node_modules directory`)
}

const results = []
const check = (label, condition, detail) => {
  results.push([condition ? 'PASS' : 'FAIL', label, condition ? '' : ` => ${String(detail)}`])
}

const { Context } = await import(harnessModule('@deepseek-ai/cordis'))
const { emitAgentEvent } = await import(harnessModule('@deepseek-ai/dsh-agent'))
const bridge = await import(new URL('../lib/ask-bridge.mjs', import.meta.url).href)
const store = await import(new URL('../lib/store.mjs', import.meta.url).href)

const DELEGATOR = 'session-live-delegator'
const WORKER = 'session-live-worker'
const OTHER = 'session-live-other'
const statePath = join(dshHome, 'session-manager', 'state.json')

const prompted = []
let uiCalls = 0
const uiAnswer = { answers: [{ id: 'q1', selected: ['ui-answered'] }] }

const question = () => ({
  id: 'q1',
  question: 'Live runtime question?',
  options: [{ label: 'Yes (Recommended)' }, { label: 'No' }],
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Poll until `predicate` holds, so a test never races an async ledger read. */
const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return true
    await tick()
  }
  check(`timed out waiting for ${label}`, false, 'never happened')
  return false
}

/** One real root context carrying a real provider, the bridge, and a stand-in UI. */
const buildRoot = async ({ uiGraceMs = 0, uiAnswersFor = OTHER } = {}) => {
  const root = new Context()
  await root.plugin({
    name: 'test-session-controller',
    apply(ctx) {
      ctx.provide('sessionController', {
        prompt: async (request) => {
          if (prompted.some((row) => row.requestId === request.requestId)) return { accepted: true, deduped: true }
          prompted.push(request)
          return { accepted: true }
        },
      })
    },
  })
  await root.plugin({ name: bridge.name, inject: [], apply: (ctx) => bridge.apply(ctx, { timeoutMs: 180000, uiGraceMs }) })
  // Registered AFTER the bridge, exactly as api-remotes is relative to the host
  // patch row. It answers only for `uiAnswersFor`, modelling a browser that is
  // not open on the worker's session.
  await root.plugin({
    name: 'test-ui-answerer',
    apply(ctx) {
      ctx.on('user-questions/request', async (request, next) => {
        if (request.agent?.id !== uiAnswersFor) return next()
        uiCalls += 1
        return uiAnswer
      })
    },
  })
  return root
}

const ask = (root, agentId, questions, signal) =>
  root.waterfall(
    'user-questions/request',
    { questions, agent: agentId === undefined ? undefined : { id: agentId }, signal },
    () => Promise.reject(new Error('NO_PROVIDER')),
  )

// ── ① the real registry honours `prepend` ordering ───────────────────────────

{
  const order = []
  const root = new Context()
  await root.plugin({
    name: 'order-prepended',
    apply(ctx) {
      ctx.on('user-questions/request', async (request, next) => { order.push('prepended'); return next() }, { prepend: true })
    },
  })
  await root.plugin({
    name: 'order-appended',
    apply(ctx) {
      ctx.on('user-questions/request', async (request, next) => { order.push('appended'); return next() })
    },
  })
  await root.waterfall('user-questions/request', { questions: [] }, () => { order.push('inner'); return Promise.resolve(null) })
  check('the real registry accepts a prepended listener', order.includes('prepended'), JSON.stringify(order))
  check('a prepended listener runs before a later one', order[0] === 'prepended', JSON.stringify(order))
  check('the waterfall falls through to the inner handler last', order[order.length - 1] === 'inner', JSON.stringify(order))
}

// ── ② an undelegated question is answered by the UI behind the bridge ────────

const root = await buildRoot()
{
  const answer = await ask(root, OTHER, [question()])
  check('a real waterfall reaches the UI listener through the bridge', uiCalls === 1, String(uiCalls))
  check('the UI answer is what the caller receives', answer === uiAnswer, JSON.stringify(answer))
  check('an undelegated question delivers no notice', prompted.length === 0, JSON.stringify(prompted))
}

// ── ③ a browser on the worker's own session still answers it first ───────────

{
  // A generous grace makes "the UI answers first" deterministic rather than a
  // microtask-vs-macrotask race.
  const ownRoot = await buildRoot({ uiGraceMs: 30000, uiAnswersFor: WORKER })
  const beforeUiCalls = uiCalls
  await store.addDelegation({
    id: 'dlg-live-ui',
    from: DELEGATOR,
    to: WORKER,
    task: 'live ui-first task',
    mode: 'queue',
    createdAt: Date.now(),
    baselineSeq: 0,
    status: 'pending',
  })
  const answer = await ask(ownRoot, WORKER, [question()])
  check('the worker session\'s own UI still answers its question', answer === uiAnswer, JSON.stringify(answer))
  check('that UI answer really reached the UI listener', uiCalls === beforeUiCalls + 1, String(uiCalls))
  check('a UI-answered delegated question sends no notice', prompted.length === 0, JSON.stringify(prompted))
  await store.dropDelegation('dlg-live-ui')
}

// ── ④ a delegated question with no browser is forwarded, and the reply answers ─

{
  await store.addDelegation({
    id: 'dlg-live-1',
    from: DELEGATOR,
    to: WORKER,
    task: 'live integration task',
    mode: 'queue',
    createdAt: Date.now(),
    baselineSeq: 0,
    status: 'pending',
  })

  const beforeUiCalls = uiCalls
  const pending = ask(root, WORKER, [question()])
  await waitFor(() => prompted.length === 1, 'the delegator notice')

  check('the bridge delivered exactly one notice into the delegator session', prompted.length === 1, String(prompted.length))
  check('the notice names the delegator session', prompted[0]?.sessionId === DELEGATOR, String(prompted[0]?.sessionId))
  check('the notice is queued', prompted[0]?.mode === 'queue', String(prompted[0]?.mode))
  check('the un-watched question never reached the UI answerer', uiCalls === beforeUiCalls, String(uiCalls))
  check('the notice carries the question text', prompted[0]?.content[0].text.includes('Live runtime question?'), prompted[0]?.content[0].text)
  check('the notice carries the recommended default', prompted[0]?.content[0].text.includes('← 默认推荐'), prompted[0]?.content[0].text)

  // The delegator's reply arrives as a real emit on the real registry.
  emitAgentEvent(root, { id: WORKER }, 'agent/inbox/inserted', {
    message: { role: 'user', content: [{ type: 'text', text: 'No' }], source: { kind: 'user' } },
  })

  const answer = await pending
  check('the delegator reply resolves the real waterfall', answer.answers[0].selected[0] === 'No', JSON.stringify(answer))

  const ledger = JSON.parse(await readFile(statePath, 'utf8')).delegations
  const row = ledger.find((item) => item.id === 'dlg-live-1')
  check('the real store persisted the hand-off marker', row.note.includes('提问已转交'), JSON.stringify(row.note))
}

// ── report ───────────────────────────────────────────────────────────────────

const failed = results.filter(([status]) => status === 'FAIL')
for (const [status, label, detail] of results) {
  if (status === 'FAIL') console.log(`FAIL ${label}${detail}`)
}
console.log(`${String(results.length - failed.length)}/${String(results.length)} passed`)
await rm(dshHome, { recursive: true, force: true })
if (failed.length > 0) process.exit(1)
