# Fencing tokens

A mutex makes sure that one holder at a time has a key. But a holder can lose its key and not know it, for example when its process freezes. A **fencing token** lets the resource refuse the work of that **stale holder**.

The technique, the rules for a fenced resource, and the token sources are in [`@zukhruf/fencing`](../../../fencing/README.md). This page tells only what the mutex adds: each lease has a token, and each lock store has a default token source.

## Each lease has a token

The task gets a `FencedLease` of `@zukhruf/fencing`. Each grant of a key gives a higher token than all earlier grants of that key. Send the token with each write, and let the resource refuse lower tokens:

```ts
await mutex.acquire('product:42', async (lease) => {
  await stock.reserve('product:42', lease.token);
});
```

Sometimes the lock store sees the loss, and then the signal of the lease aborts with `LeaseLostError` (see [failure modes](./failure-modes.md#errors)). But a frozen holder can write before its lock store sees the loss, so the signal cannot replace the fencing token.

See [`apps/reservation-app/src/fenced-stock.ts`](../../../../apps/reservation-app/src/fenced-stock.ts) for a full fenced resource.

## Token sources

The lock store calls its token source while it holds the key. Thus two tokens for one key are never made at the same time.

| Token source                | Tokens continue after a restart?             | Default for                                                  |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `CounterTokenSource`        | No. It counts in memory.                     | `MemoryStore`, `IpcLockCoordinator`, `ThreadLockCoordinator` |
| `MonotonicClockTokenSource` | No. It reads the clock of the process.       | —                                                            |
| `FileTokenSource`           | Yes. It keeps one counter file for each key. | `TicketQueueFileStore`, `LockFileStore`, `SqliteStore`       |
| `EpochTokenSource`          | Yes. Each new leader has a higher epoch.     | `SocketStore` (fixed)                                        |

**Use a durable token source with a durable resource.** A database keeps the highest token after your process stops. A memory token source starts again at 1. Then the database refuses all new writes. Give the lock store a durable token source:

```ts
import { FileTokenSource } from '@zukhruf/fencing';
import { MemoryStore, Mutex } from '@zukhruf/mutex';

const mutex = new Mutex(
  new MemoryStore({ tokens: new FileTokenSource('/var/lib/my-app/fences') }),
);
```

## Evidence

- `apps/reservation-app/src/fenced-stock.test.ts`: an older token is refused as `'stale'`, and one holder can write two times with one token.
- `src/lock-stores/socket/socket-store.test.ts`: a holder that was frozen past the grace window writes after a newer holder. A fenced register refuses the write as `'stale'`.
- `src/mutex/mutex.test.ts`: in each lock store, tokens increase in the order of the grants, also across four processes.
- `src/lock-stores/socket/wire-compatibility.test.ts` and `npx nx run mutex:test-latest-release`: the tokens on the wire and in `.fence` files are the same as in the published version.
