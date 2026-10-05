# Fencing tokens

A mutex makes sure that one holder at a time has a key. But a holder can lose its key and not know it. A **fencing token** lets the resource refuse the work of that holder.

## The problem

Process A holds the key and reads the stock. Then process A freezes, for example during a long garbage collection or a `SIGSTOP`. The lock store decides that A stopped, and it grants the key to process B. B sells the last item. Then A continues, and A also sells the last item.

```
holder A:  [lease] read stock=1 ......frozen...... write stock=0   ✗ stale write
holder B:                       [lease] read stock=1, write stock=0
result:    two customers got the last item
```

A is a **stale holder**. The mutex cannot stop A, because A does not know that it lost the key.

## The solution

Each lease has a fencing token. Each grant of a key has a higher token than all earlier grants of that key. The holder sends its token with each write. The resource keeps the highest token that it has seen, and it refuses a lower one.

```
B writes with token 34 → resource: highest = 34, write accepted
A writes with token 33 → resource: 33 < 34, write refused ✓
```

Read the token from the lease:

```ts
await mutex.acquire('product:42', async (lease) => {
	await stock.reserve('product:42', lease.token);
});
```

## The resource must do its part

The lock store makes the tokens. The resource must compare them. A stale write goes directly to the resource, not through the mutex. Thus only the resource can refuse it. A resource that compares tokens is a **fenced resource**.

In SQL, do the compare and the write in one statement:

```sql
UPDATE stock
SET quantity = quantity - 1, fence = :token
WHERE product = :product AND fence <= :token AND quantity > 0;
```

Follow these rules:

- **Refuse only lower tokens.** Use `fence <= :token`, not `fence < :token`. One holder can write two times with the same token.
- **Do the read and the write in one statement.** If you read first and write later, a stale write can occur between the two.
- **Compare the tokens as integers.** In `node:sqlite`, bind `token.value` (a `bigint`) and open the database with `readBigInts: true`.

See [`examples/reservation-app/fenced-stock.ts`](../../examples/reservation-app/fenced-stock.ts) for a full fenced resource.

Fencing tokens protect only fenced resources. If a stale holder sends an email or calls an API that does not compare tokens, the token does not help.

## Token sources

A **token source** makes the fencing tokens for a lock store. The lock store calls it while the key is held. Thus two tokens for one key are never made at the same time.

| Token source | Tokens continue after a restart? | Default for |
|---|---|---|
| `CounterTokenSource` | No. It counts in memory. | `MemoryStore`, `IpcLockCoordinator`, `ThreadLockCoordinator` |
| `MonotonicClockTokenSource` | No. It reads the clock of the process. | — |
| `FileTokenSource` | Yes. It keeps one counter file for each key. | `TicketQueueFileStore`, `LockFileStore`, `SqliteStore` |
| `EpochTokenSource` | Yes. Each new leader has a higher epoch. | `SocketStore` (fixed) |

**Use a durable token source with a durable resource.** A database keeps the highest token after your process stops. A memory token source starts again at 1. Then the database refuses all new writes. Give the lock store a durable token source:

```ts
import { FileTokenSource, MemoryStore, Mutex } from 'mutex';

const mutex = new Mutex(
	new MemoryStore({ tokens: new FileTokenSource('/var/lib/my-app/fences') }),
);
```

## Why not UUIDv7

UUIDv7 values are unique and approximately ordered by time. A fencing token must be strictly ordered. We tested `crypto.randomUUIDv7()` in Node 26:

- One thread, 100,000 values: 50,160 values were lower than the value before them.
- Two threads, 2,000 grants one after the other: 936 later grants had a lower value.

Many grants occur in the same millisecond. In that millisecond, UUIDv7 is random. A fenced resource would then refuse correct holders and accept stale holders.

## Evidence

- `examples/reservation-app/fenced-stock.test.ts`: an older token is refused as `'stale'`, and one holder can write two times with one token.
- `src/lock-stores/socket/socket-store.test.ts`: a holder that was frozen past the grace window writes after a newer holder. A fenced register refuses the write as `'stale'`.
- `src/mutex/mutex.test.ts`: in each lock store, tokens increase in the order of the grants, also across four processes.
