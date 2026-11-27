# Code that is in two places

This repository follows the Rule of Three, and it counts places, not packages. This note records the code that is in two places inside this package, and the test helpers that it copied. While both places exist, a fix to one place goes into the other place too, and the commit names both files.

The paths are in `packages/rpc/src`.

## In two places

**Listeners only while the connection is referenced.** Moved from the mutex with the adapters (#4984).

- Places: `ref`, `unref` and `close` of `ParentPortConnection` (`channel/parent-port-connection.ts`) and of `ProcessChannelConnection` (`channel/process-channel-connection.ts`).
- Same: `ref` calls `stopListening` and then `listen`, so a second `ref` does not listen twice. `unref` calls `stopListening`. `close` calls `unref`.
- Differs: only the events that tell that the peer is gone. The process channel gives `disconnect` to `SharedChannelConnection` (`channel/shared-channel-connection.ts`). The port gives no event, because the thread that started the worker cannot stop while its workers run.

**Listeners from the start until `close`.** Moved from the mutex with the adapters (#4984).

- Places: the constructor, `ref`, `unref` and `close` of `WorkerConnection` (`channel/worker-connection.ts`) and of `ChildProcessConnection` (`channel/child-process-connection.ts`).
- Same: the constructor calls `listen`. `ref` and `unref` do nothing, because the peer keeps this process alive while it runs. `close` calls `stopListening`.
- Differs: the event that tells that the peer is gone: `exit` of the worker, or `disconnect` of the child.

Backlog #2544 is about this code: `close` stops the listeners, but it does not emit `close`. A fix for it goes into both places.

## In more than two places

**`isRecord`.** `shared/is-record.ts` is the third copy of `packages/mutex/src/shared/is-record.ts` and `packages/single-flight/src/shared/is-record.ts`. It stays a copy: one home would give this package a dependency that it does not have (root ADR 0001, rule 4).

## Test helpers copied

Test helpers in different packages stay copied (root ADR 0001, rule 2).

- `packages/mutex/src/testing/scripted-peer.ts` → `testing/scripted-peer.ts`: only the import of `Connection` differs. The stand-in tests of the supervisor moved here from the mutex, and the mutex's `remote-locking.test.ts` still uses its copy.
- `packages/mutex/src/testing/watch.ts` → `testing/watch.ts`: no change.
