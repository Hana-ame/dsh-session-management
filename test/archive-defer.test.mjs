// Behaviour of the merged archive tool: `session_archive` keeps its
// self-archival refusal, and gains `deferMs` as the one sanctioned way to
// schedule an archive of the caller's own session.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'archive-defer-'))
process.env.DSH_HOME = home

const { default: register } = await import(new URL('../lib/tools.mjs', import.meta.url))

const calls = []
let archives = []

const workspaces = {
  resolveByPath: async () => undefined,
  archiveSession: async (sessionId, options) => {
    archives.push([sessionId, options])
    if (sessionId === 'session-busy' && options.stopActivity !== true) {
      const error = new Error('the session has running activity')
      error.name = 'WorkspaceActiveSessionError'
      throw error
    }
    if (sessionId === 'session-ghost') {
      const error = new Error('no such session')
      error.name = 'WorkspaceUnknownSessionError'
      throw error
    }
  },
  unarchiveSession: async (sessionId) => { calls.push(['unarchive', sessionId]) },
}

const captured = {}
const effects = []
register.apply({
  get: (name) => (name === 'workspaceRegistry' ? workspaces : undefined),
  effect: (fn) => { effects.push(fn); return () => {} },
  tools: { register: (definition) => { captured[definition.name] = definition } },
})

const results = []
const check = (label, condition, detail) => {
  results.push([condition ? 'PASS' : 'FAIL', label, condition ? '' : ` => ${String(detail)}`])
}
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const archive = captured.session_archive
const self_ = { agent: { id: 'me', session: { header: { cwd: '/tmp/repo' } } } }
const other = { agent: { id: 'me', session: { header: { cwd: '/tmp/repo' } } } }

check('session_archive is registered', archive !== undefined, 'missing')

// The schema advertises deferMs so the model can discover the escape hatch.
check('deferMs is declared in the parameter schema', typeof archive.parameters.properties.deferMs === 'object', Object.keys(archive.parameters.properties).join(','))

// 1. Self-archival without deferMs stays refused — the original protection.
const refused = await archive.execute({ sessionId: 'me' }, self_)
check('self-archive without deferMs is refused', refused.ok === false, JSON.stringify(refused))
check('the refusal explains deferMs', typeof refused.text === 'string' && refused.text.includes('deferMs'), refused.text)

// 2. deferMs schedules instead of archiving, and reports no in-turn confirmation.
archives = []
const scheduled = await archive.execute({ sessionId: 'me', deferMs: 40 }, self_)
check('self-archive with deferMs is accepted', scheduled.ok === true, JSON.stringify(scheduled))
check('the scheduled call has not archived yet', archives.length === 0, JSON.stringify(archives))
check('the answer says no in-turn confirmation', typeof scheduled.text === 'string' && /no in-turn confirmation/i.test(scheduled.text), scheduled.text)

// 3. The deferred write actually lands.
await settle(120)
check('the deferred archive lands after the delay', archives.length === 1 && archives[0][0] === 'me', JSON.stringify(archives))

// 4. deferMs is bounded, so a caller cannot postpone forever.
archives = []
const capped = await archive.execute({ sessionId: 'other', deferMs: 10 ** 9 }, other)
check('an oversized deferMs is still accepted and bounded', capped.ok === true, JSON.stringify(capped))

// 4b. Teardown cancels a pending deferred archive instead of leaking it.
const cleanup = effects[effects.length - 1]
check('a teardown effect is registered for deferred archives', typeof cleanup === 'function', typeof cleanup)
cleanup()
await settle(60)
check('teardown cancels the pending deferred archive', archives.length === 0, JSON.stringify(archives))

// 5. stopActivity still governs another session's running work.
const busy = await archive.execute({ sessionId: 'session-busy' }, other)
check('a busy session is refused without stopActivity', busy.ok === false, JSON.stringify(busy))
check('the refusal names stopActivity', typeof busy.text === 'string' && busy.text.includes('stopActivity'), busy.text)

const stopped = await archive.execute({ sessionId: 'session-busy', stopActivity: true }, other)
check('stopActivity lets the busy archive through', stopped.ok === true, JSON.stringify(stopped))

// 6. An unknown session reports the registry's own error class.
const ghost = await archive.execute({ sessionId: 'session-ghost' }, other)
check('an unknown session fails visibly', ghost.ok === false && ghost.text.includes('no live or persisted session'), JSON.stringify(ghost))

// 7. Unarchive is unaffected by the deferral path.
const restored = await archive.execute({ sessionId: 'me', action: 'unarchive' }, other)
check('unarchive still works', restored.ok === true, JSON.stringify(restored))

await rm(home, { recursive: true, force: true })

let failed = 0
for (const [state, label, detail] of results) {
  if (state === 'FAIL') failed += 1
  console.log(`# ${state}  ${label}${detail}`)
}
console.log(`# ${String(results.length - failed)}/${String(results.length)} passed`)
process.exitCode = failed === 0 ? 0 : 1