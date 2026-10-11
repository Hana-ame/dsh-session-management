# @local/session-management

Session management for a single agent preset: it coordinates other sessions (create / list / read / fork / assign / queue / model / compact) and controls their GUI placement (archive / unarchive / pin / unpin).

Every tool is registered inside the preset's own scope, so no other preset can see them.

## Exports

| Path | Module |
| --- | --- |
| `./tools` | tool definitions |
| `./workspace` | workspace registry bridge |
| `./loop` | idle / delegation loop |
| `./store` | durable state store |
| `./ask-bridge` | ask-user bridge (host plane) |

## Wiring

Bundle patch: `cordis.patch.yml`. Declare a preset that imports `@local/session-management/tools` to give one agent the coordinator role.

> The coordinator preset is currently loaded from a local source directory via a symlink in the profile's `node_modules`, not from npm. Publishing this repository does not change which file the running profile reads.

## Tests

There is no test script; run the suites directly:

```sh
node test/tools.test.mjs
node test/delegation-idempotency.test.mjs
node test/archive-defer.test.mjs
node lib/loop.test.mjs
node lib/ask-bridge.test.mjs
```
