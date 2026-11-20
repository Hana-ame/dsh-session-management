// ④ Ask bridge — the missing answerer for a DELEGATED session.
//
// `ask_user_question` (@deepseek-ai/dsh-tool-ask-user) never times out: it awaits
// the Agent-scoped `user-questions/request` waterfall until a UI answerer answers
// or the calling turn's signal aborts. The seam rejects a caller that is a
// *runtime-owned child* (`DELEGATED_CALLER`) precisely because such a child has
// no human answerer — but a session delegated with `session_send` is its own
// runtime ROOT, so it passes that guard, reaches the waterfall, and only its own
// session's browser client can answer it. Nobody is watching that session, so the
// tool call blocks forever. That is the 107-minute stall: the task was finished,
// and the worker sat inside one unanswered tool call.
//
// This module installs the answerer that case is missing, on the HOST plane,
// once per process (NOT per session — a preset row mounts one copy per session
// and a worker usually runs a different preset anyway, so a preset-scoped
// listener would never see the worker's question):
//
//   * A question whose asking agent is the TARGET of a still-pending delegation
//     is claimed here instead of being left for a browser that may not exist. The
//     listener is registered `prepend`, so it decides before the api-remotes
//     forwarder parks the same request on an absent browser.
//   * The session's OWN UI still gets the first chance, exactly as before this
//     row existed: the listener calls `next()` immediately and races that answer
//     against everything below. A human watching the worker's own tab is
//     therefore unaffected — they answer it just like they always could.
//   * Only when that answer does not arrive within the UI grace does the question
//     (原文 + options + the recommended default) get forwarded into the
//     DELEGATOR's session as one queued prompt, through the very same
//     `sessionController.prompt` primitive and the same prompt-correlation dedupe
//     (`hasPromptRequest`) the settlement callbacks use. No second delivery path
//     is introduced, and no session-manager tool is modified.
//   * The notice's `requestId` is DERIVED from the delegation id plus a digest of
//     the question body, so a retried identical question dedupes while a genuinely
//     different question still gets through.
//   * The delegator answers with one ordinary `session_send` into the worker; that
//     reply lands in the worker's inbox as a durable user message. This module
//     watches that inbox insertion and returns the reply text as the question's
//     answer, so the worker's blocked tool call unblocks.
//   * If no answer arrives within the delegated window, the worker is released
//     with the recommended option (the first option, as the tool contract
//     prescribes) and an explicit "no one answered, this is the default" note, so
//     it continues under a stated assumption instead of hanging.
//
// Foreground human use is untouched in both directions: a question from a session
// that is not a pending delegation's target falls straight through with `next()`,
// and a question from one that IS still reaches its own UI first.
//
// Plane: host composition. It publishes no service (so it needs no `isolate`
// realm) and must be mounted exactly once per process; see `INSTALL.md`.
//
// It imports `./store.mjs` — the one durable ledger — by relative path, so it
// shares that module's single reader/writer over
// `<DSH_HOME>/session-manager/state.json` rather than opening the file again.

import { createHash } from 'node:crypto'
import { noteDelegation, readState } from './store.mjs'

/** How long the session's own UI gets to answer before the delegator is told. */
export const DEFAULT_UI_GRACE_MS = 15000
/** How long the delegator then has to reply before the worker proceeds on the default. */
export const DEFAULT_TIMEOUT_MS = 180000
/** Floors/ceilings keep a misconfigured value from becoming "no timeout" or "instant". */
export const MIN_TIMEOUT_MS = 15000
export const MAX_TIMEOUT_MS = 900000
export const MAX_UI_GRACE_MS = 120000

/** Prefix of the ask notice's prompt correlation id; distinct from the settlement notice's. */
export const ASK_NOTICE_PREFIX = 'preset-delegation-ask'

/** Marker written into the delegation's note so a hand-off is recorded durably. */
export const HANDOFF_MARKER = '提问已转交'

/** Stable digest of a question body: an identical retry dedupes, a new question does not. */
export const questionDigest = (questions) => {
  const body = (Array.isArray(questions) ? questions : []).map((question) => ({
    id: question !== null && typeof question === 'object' ? question.id : undefined,
    question: question !== null && typeof question === 'object' ? question.question : undefined,
    options: Array.isArray(question?.options) ? question.options.map((option) => option?.label) : [],
  }))
  return createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 8)
}

/**
 * The correlation id of one ask notice, derived (never minted fresh) so the
 * controller's `hasPromptRequest` dedupe makes a retry a no-op.
 */
export const noticeRequestId = (delegationId, digest) => `${ASK_NOTICE_PREFIX}-${delegationId}-${digest}`

/** The option this bridge falls back to: the tool contract puts the recommended one first. */
export const recommendedLabel = (question) => {
  const options = Array.isArray(question?.options)
    ? question.options.filter((option) => option !== null && typeof option === 'object' && typeof option.label === 'string')
    : []
  if (options.length === 0) return null
  const tagged = options.find((option) => /\(recommended\)|（推荐）|\(推荐\)|推荐/.test(option.label))
  return (tagged ?? options[0]).label
}

/**
 * The answers a released worker receives when nobody replied. Options present →
 * the recommended/first label. No options → an explicit custom note, because
 * inventing a choice would be worse than saying none was made.
 */
export const defaultAnswers = (questions) => ({
  answers: (Array.isArray(questions) ? questions : []).map((question) => {
    const label = recommendedLabel(question)
    return {
      id: String(question?.id ?? ''),
      selected: label === null ? [] : [label],
      ...(label === null ? { custom: '（无人作答；请按最合理的假设继续，并在交付里标注该假设）' } : {}),
    }
  }),
})

/** Match one free-text reply against a question's options; exact first, then substring. */
export const matchOption = (text, question, multiSelect) => {
  const options = Array.isArray(question?.options)
    ? question.options.filter((option) => option !== null && typeof option === 'object' && typeof option.label === 'string')
    : []
  const normalize = (value) => String(value).trim().toLowerCase()
  const reply = normalize(text)
  const exact = options.find((option) => normalize(option.label) === reply)
  if (exact !== undefined) return [exact.label]
  const contained = options.filter((option) => reply.includes(normalize(option.label)))
  if (contained.length === 0) return []
  return (multiSelect === true ? contained : [contained[0]]).map((option) => option.label)
}

/** Turn one free-text delegator reply into the answer shape `ask()` resolves with. */
export const answersFromReply = (text, questions) => {
  const body = typeof text === 'string' ? text.trim() : ''
  const list = Array.isArray(questions) ? questions : []
  return {
    answers: list.map((question) => {
      const selected = matchOption(body, question, question?.multiSelect)
      return {
        id: String(question?.id ?? ''),
        selected,
        ...(selected.length === 0 ? { custom: body } : {}),
      }
    }),
  }
}

const clip = (value, limit) => {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

const shortId = (id) => (typeof id === 'string' ? id.replace(/^session-/, '').slice(0, 8) : String(id ?? ''))

/** Human-readable duration for a configured window; never rounds a real wait down to "0 分钟". */
export const describeWindow = (ms) => {
  const value = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  if (value >= 60000) return `${String(Math.round(value / 60000))} 分钟`
  return `${String(Math.round(value / 1000))} 秒`
}

/** The prompt text delivered into the delegator's session. */
export const renderNotice = (delegation, questions, timeoutMs) => {
  const list = Array.isArray(questions) ? questions : []
  const wait = describeWindow(timeoutMs)
  const lines = [
    `[委托提问] 会话 ${shortId(delegation.to)} 在任务中停下来提问。它被委派给你的会话，若无人作答它就会一直等下去，因此这个问题转交给你。`,
    `任务：「${delegation.task.length > 0 ? clip(delegation.task, 120) : '(no task text)'}」`,
    '',
  ]
  list.forEach((question, index) => {
    const header = typeof question?.header === 'string' && question.header.length > 0 ? `（${question.header}）` : ''
    lines.push(`问题 ${index + 1}/${list.length}（id: ${String(question?.id ?? '')}）${header}`)
    lines.push(`  ${String(question?.question ?? '')}`)
    const options = Array.isArray(question?.options) ? question.options : []
    const fallback = recommendedLabel(question)
    if (options.length > 0) {
      options.forEach((option) => {
        const tag = option?.label === fallback ? '  ← 默认推荐' : ''
        const detail = typeof option?.description === 'string' && option.description.length > 0 ? ` — ${option.description}` : ''
        lines.push(`  - ${String(option?.label ?? '')}${detail}${tag}`)
      })
    } else {
      lines.push('  （没有选项；它会在无人作答时按最合理假设继续）')
    }
    lines.push('')
  })
  lines.push(`${wait}内没有答复时，它会自动按「默认推荐」项继续（或按最合理假设继续），并把这个假设写进交付。`)
  lines.push(`请直接回复它：session_send(sessionId="${delegation.to}", text="你的答复")。你的答复会作为这个提问的结果返回给它。`)
  return lines.join('\n')
}

/** The newest still-pending delegation whose target is `workerId`, or null. */
export const findPendingDelegation = (state, workerId) => {
  const rows = state !== null && state !== undefined && Array.isArray(state.delegations) ? state.delegations : []
  let best = null
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.to !== workerId || row.status !== 'pending') continue
    if (best === null || row.createdAt > best.createdAt) best = row
  }
  return best
}

/** Read the readable text of one user message's content blocks. */
const messageText = (message) => {
  if (message === null || message === undefined || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content) ? message.content : []
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Only a real user-authored message counts as the delegator's reply. */
const isUserAuthored = (message) => {
  if (message === null || typeof message !== 'object' || message.role !== 'user') return false
  const source = message.source
  return source !== null && source !== undefined && typeof source === 'object' && source.kind === 'user'
}

/** The signal-shaped argument `sessionController.prompt` requires; nothing here is cancellable. */
const callerSignal = { aborted: false, throwIfAborted() {}, addEventListener() {}, removeEventListener() {} }

/**
 * Normalize one config value into a usable timeout.
 *
 * `0` disables the bridge's claiming entirely; that is the operator's explicit
 * opt-out and is different from "misconfigured", which falls back to the default.
 */
export const resolveTimeoutMs = (value) => {
  if (value === 0) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  if (value < 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/** How long the session's own UI gets first. `0` forwards as soon as nobody answered synchronously. */
export const resolveUiGraceMs = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_UI_GRACE_MS
  return Math.min(Math.trunc(value), MAX_UI_GRACE_MS)
}

export const name = 'session-manager-ask-bridge'

/**
 * No hard dependency: a deployment without `sessionController` must still mount
 * this row (it simply falls through every question), never sit waiting for a
 * service and take the composition down with it.
 */
export const inject = []

export function apply(ctx, config) {
  const timeoutMs = resolveTimeoutMs(config !== null && typeof config === 'object' ? config.timeoutMs : undefined)
  if (timeoutMs === 0) return
  const uiGraceMs = resolveUiGraceMs(config !== null && typeof config === 'object' ? config.uiGraceMs : undefined)

  /** agentId → the set of settle() callbacks for questions that agent is blocked in. */
  const waiters = new Map()
  const timers = new Set()

  const release = (agentId, value) => {
    const pending = waiters.get(agentId)
    if (pending === undefined) return false
    waiters.delete(agentId)
    for (const settle of pending) settle(value)
    return true
  }

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    waiters.clear()
  }, 'session-manager: ask-bridge timers')

  // The reply path: the delegator's `session_send` puts an ordinary user message
  // into the worker's inbox. The inbox append is durable and emits immediately,
  // independent of the worker's blocked turn, so this fires while `ask()` waits.
  if (typeof ctx.on === 'function') {
    ctx.on('agent/inbox/inserted', (payload) => {
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      const message = payload !== null && typeof payload === 'object' ? payload.message : undefined
      if (agent === null || agent === undefined || typeof agent.id !== 'string') return
      if (!isUserAuthored(message)) return
      const text = messageText(message).trim()
      if (text.length === 0) return
      release(agent.id, { kind: 'reply', text })
    })

    // `prepend` is what makes this the deciding answerer: api-remotes registers
    // its forwarding listener on the same host plane at boot, and running after
    // it would park a delegated question on a browser that may not be there.
    ctx.on('user-questions/request', async function (request, next) {
      const agent = request?.agent
      if (agent === undefined || agent === null || typeof agent.id !== 'string') return next()

      // Who, if anyone, is waiting on this agent? A still-pending delegation row
      // whose target is this agent is exactly the "delegated worker" condition;
      // every other question is an ordinary foreground one and passes through.
      let delegation = null
      try {
        delegation = findPendingDelegation(await readState(), agent.id)
      } catch {
        delegation = null
      }
      if (delegation === null) return next()

      const delegator = delegation.from
      const controller = ctx.get('sessionController')
      if (
        controller === undefined ||
        controller === null ||
        typeof controller.prompt !== 'function' ||
        typeof delegator !== 'string' ||
        delegator.length === 0
      ) {
        return next()
      }

      const questions = Array.isArray(request.questions) ? request.questions : []
      const digest = questionDigest(questions)
      const signal = request.signal

      // The session's OWN UI gets the first chance, exactly as it did before this
      // row existed. `next()` runs the rest of the chain — including api-remotes,
      // which parks the request on this session's browser — and whatever it
      // eventually resolves with is a legitimate answer that wins the race below.
      const uiOutcome = Promise.resolve()
        .then(() => next())
        .then(
          (value) => ({ kind: 'ui', value }),
          () => ({ kind: 'no-ui' }),
        )

      // Forward the question into the delegator's session once the UI has had its
      // grace. `mode: "queue"` never interrupts a turn the delegator is running.
      let forwarding = null
      const forward = () => {
        if (forwarding !== null) return forwarding
        forwarding = (async () => {
          try {
            await controller.prompt(
              {
                requestId: noticeRequestId(delegation.id, digest),
                sessionId: delegator,
                mode: 'queue',
                content: [{ type: 'text', text: renderNotice(delegation, questions, timeoutMs) }],
              },
              callerSignal,
            )
          } catch (error) {
            try {
              await noteDelegation(delegation.id, `提问转交失败：${error instanceof Error ? error.message : String(error)}`)
            } catch {
              // Recording the failure is best-effort; releasing the worker is what matters.
            }
            return { ok: false }
          }
          // Durable "this question was handed off", written once per distinct question.
          try {
            const marker = `${HANDOFF_MARKER}:${digest}`
            const latest = await readState()
            const row = Array.isArray(latest?.delegations) ? latest.delegations.find((item) => item.id === delegation.id) : undefined
            if (row !== undefined && typeof row.note === 'string' && !row.note.includes(marker)) {
              await noteDelegation(delegation.id, marker)
            }
          } catch {
            // The derived requestId already prevents duplicate delivery; the note is observability.
          }
          return { ok: true }
        })()
        return forwarding
      }

      const outcome = await new Promise((resolve) => {
        let settled = false
        let graceTimer = null
        let deadlineTimer = null
        const settle = (value) => {
          if (settled) return
          settled = true
          if (graceTimer !== null) clearTimeout(graceTimer)
          if (deadlineTimer !== null) clearTimeout(deadlineTimer)
          timers.delete(graceTimer)
          timers.delete(deadlineTimer)
          const pending = waiters.get(agent.id)
          if (pending !== undefined) {
            pending.delete(settle)
            if (pending.size === 0) waiters.delete(agent.id)
          }
          if (signal !== undefined && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
        const onAbort = () => settle({ kind: 'abort' })
        const pending = waiters.get(agent.id)
        if (pending === undefined) waiters.set(agent.id, new Set([settle]))
        else pending.add(settle)

        // The deadline only starts mattering after the grace, so the delegator
        // always gets the full configured window to answer.
        graceTimer = setTimeout(() => {
          timers.delete(graceTimer)
          void forward().then((result) => {
            if (result.ok === false) settle({ kind: 'undeliverable' })
          })
        }, uiGraceMs)
        deadlineTimer = setTimeout(() => settle({ kind: 'timeout' }), uiGraceMs + timeoutMs)
        timers.add(graceTimer)
        timers.add(deadlineTimer)

        uiOutcome.then((result) => {
          if (result.kind === 'ui') settle(result)
        })
        if (signal !== undefined && typeof signal.addEventListener === 'function') {
          if (signal.aborted === true) settle({ kind: 'abort' })
          else signal.addEventListener('abort', onAbort)
        }
      })

      // A human watching this session answered it: unchanged behavior, and the
      // delegator is never bothered.
      if (outcome.kind === 'ui') return outcome.value
      if (outcome.kind === 'reply') return answersFromReply(outcome.text, questions)
      if (outcome.kind === 'abort') throw new Error('ask_user_question was aborted before the delegator answered')
      if (outcome.kind === 'undeliverable') return defaultAnswers(questions)
      // Timed out: release the worker on the stated default rather than block it.
      try {
        await noteDelegation(delegation.id, `提问转交后 ${describeWindow(timeoutMs)}无答复，已按默认继续`)
      } catch {
        // The released answer is what unblocks the worker; the note is observability.
      }
      return defaultAnswers(questions)
    }, { prepend: true })
  }
}

export default { name, inject, apply }
