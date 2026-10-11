/**
 * Workspace registry tools: pin/unpin plus a read-only state dump.
 *
 * Archiving deliberately does NOT live here — `session_archive` in
 * `./tools.mjs` owns it, and it also clears the pin in the same write, so a
 * second implementation would only create two paths to one effect.
 *
 * The registry is resolved through `ctx.get()` rather than declared as a hard
 * `inject`. This bundle's plugins mount inside an agent preset, and a missing
 * provider must degrade to a readable tool failure instead of failing the
 * whole preset's activation.
 *
 * @module @local/session-management/workspace
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Persisted document the runtime registry reconciles against at startup. */
const FALLBACK_STORAGE_PATH = join(homedir(), '.dsh', 'storages', 'workspace.json')

const OUTPUT = {
  schema: {},
  render(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  },
}

const asString = (value) => (typeof value === 'string' ? value : '')
const stringList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry.length > 0) : [])

/** Resolve `$DSH_HOME`, matching the harness's own rule. */
function harnessHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured !== 'string' || configured.length === 0) return join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2))
  return configured
}

/** Read the persisted workspace document, falling back to the default path. */
async function readPersisted() {
  const configured = join(harnessHome(), 'storages', 'workspace.json')
  for (const path of configured === FALLBACK_STORAGE_PATH ? [configured] : [configured, FALLBACK_STORAGE_PATH]) {
    try {
      const doc = JSON.parse(await readFile(path, 'utf8'))
      const global = doc !== null && typeof doc === 'object' && doc.global !== null && typeof doc.global === 'object' ? doc.global : {}
      return {
        ok: true,
        path,
        archivedSessionIds: stringList(global.archivedSessionIds),
        pinnedSessionIds: stringList(global.pinnedSessionIds),
        workspaceIds: stringList(global.workspaceIds),
      }
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, path: configured, archivedSessionIds: [], pinnedSessionIds: [], workspaceIds: [] }
}

/** Snapshot of the live registry, read defensively across its whole surface. */
function registryState(registry) {
  return {
    archivedSessionIds: stringList(registry.archivedSessionIds),
    pinnedSessionIds: stringList(registry.pinnedSessionIds),
    workspaces: registry.list().map((workspace) => ({
      workspaceId: asString(workspace.workspaceId),
      path: asString(workspace.path),
      title: asString(workspace.title),
      sessionIds: stringList(workspace.sessionIds),
    })),
  }
}

/** Two-way set difference between the live registry and the persisted file. */
function divergence(live, disk) {
  const compare = (registrySet, persistedSet) => ({
    onlyInRegistry: registrySet.filter((id) => !persistedSet.includes(id)),
    onlyInDisk: persistedSet.filter((id) => !registrySet.includes(id)),
  })
  return {
    archivedSessionIds: compare(live.archivedSessionIds, disk.archivedSessionIds),
    pinnedSessionIds: compare(live.pinnedSessionIds, disk.pinnedSessionIds),
  }
}

/**
 * Build one workspace tool. `registryOf` is captured in the closure rather
 * than passed through `execute`, which receives `(args, exec)` from the tool
 * pipeline. A missing provider degrades to a readable failure instead of
 * throwing out of the pipeline.
 */
function registryTool(name, description, properties, registryOf, run) {
  return {
    name,
    description,
    parameters: { type: 'object', properties },
    output: OUTPUT,
    async execute(args) {
      const registry = registryOf()
      if (registry === null || registry === undefined) {
        return { ok: false, text: 'workspaceRegistry is unavailable in this deployment; this tool cannot run here.' }
      }
      const input = args !== null && typeof args === 'object' ? args : {}
      const sessionId = asString(input.sessionId).trim()
      return run({ registry, input, sessionId })
    },
  }
}

export default {
  name: 'session-workspace',
  inject: ['tools'],
  apply(ctx) {
    // Resolved per call so a late host provider is still picked up.
    const registryOf = () => ctx.get('workspaceRegistry')

    ctx.tools.register(registryTool(
      'workspace_state',
      "Read the Workspace registry that the GUI sidebar is rendered from: the running registry's in-memory archivedSessionIds and pinnedSessionIds plus each workspace's session membership, and by default how that diverges from the persisted workspace.json. Use it to tell whether a session is hidden from the sidebar, and whether the sidebar has caught up with a change yet. Archiving itself is session_archive, not this tool.",
      { includeDisk: { type: 'boolean', description: 'Also read the persisted workspace.json and report the divergence. Default true.' } },
      registryOf,
      async ({ registry, input }) => {
        const live = registryState(registry)
        const result = { registry: live }
        if (input.includeDisk !== false) {
          const disk = await readPersisted()
          result.disk = disk
          if (disk.ok) result.divergence = divergence(live, disk)
        }
        return { ok: true, text: JSON.stringify(result, null, 2) }
      },
    ))

    ctx.tools.register(registryTool(
      'workspace_pin_session',
      'Pin a session so it leads the GUI sidebar. The session must be known to persistence or be live; an archived session is refused. Idempotent for an id that is already pinned.',
      { sessionId: { type: 'string', description: 'Durable target session id, from session_list.' } },
      registryOf,
      async ({ registry, input, sessionId }) => {
        if (sessionId.length === 0) return { ok: false, text: 'sessionId is required.' }
        try {
          await registry.pinSession(sessionId)
        } catch (error) {
          return { ok: false, text: `Pinning ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        const pinned = registryState(registry).pinnedSessionIds
        return { ok: true, text: `Pinned ${sessionId}: it now leads the GUI sidebar. Unpin it with workspace_unpin_session.${pinned.length > 0 ? ` Currently pinned: ${pinned.join(', ')}` : ''}` }
      },
    ))

    ctx.tools.register(registryTool(
      'workspace_unpin_session',
      'Unpin a session so it falls back to its durable registry position in the GUI sidebar. Idempotent: an id that is not pinned resolves without writing or reordering.',
      { sessionId: { type: 'string', description: 'Durable target session id, from session_list.' } },
      registryOf,
      async ({ registry, input, sessionId }) => {
        if (sessionId.length === 0) return { ok: false, text: 'sessionId is required.' }
        try {
          await registry.unpinSession(sessionId)
        } catch (error) {
          return { ok: false, text: `Unpinning ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}` }
        }
        const pinned = registryState(registry).pinnedSessionIds
        return { ok: true, text: `Unpinned ${sessionId}: it returns to its recorded sidebar position.${pinned.length > 0 ? ` Still pinned: ${pinned.join(', ')}` : ' Nothing is pinned now.'}` }
      },
    ))
  },
}