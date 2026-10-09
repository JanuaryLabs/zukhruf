# @zukhruf/fencing

A holder can lose its lease and not know it. When it continues, it can write over the work of a newer holder. This package gives each grant a fencing token: an integer that grows with each grant. A fenced resource keeps the highest token that it accepted, and it refuses a write with a lower token. `@zukhruf/mutex` gives a fencing token on each lease.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## The problem

Process A holds a key and reads the stock. Then process A freezes, for example in a long garbage collection or after a `SIGSTOP`. The issuer decides that A stopped, and it grants the key to process B. B sells the last item. Then A continues, and A also sells the last item.

```
holder A:  [token 33] read stock=1 ......frozen...... write stock=0   ✗ stale write
holder B:                          [token 34] read stock=1, write stock=0
result:    two customers got the last item
```

A is a **stale holder**. The signal of A's lease can abort, but A can write before the issuer sees the loss. Thus the signal is a warning. Only the resource can refuse the write, because the write goes directly to the resource.

## The resource checks the token

With fencing tokens, B writes first with token 34. The resource keeps 34. Then A writes with token 33, and the resource refuses it:

```
B writes with token 34 → resource: highest = 34, write accepted
A writes with token 33 → resource: 33 < 34, write refused ✓
```

The holder does not check its token. The resource does. A holder cannot know that a newer holder exists, but the resource saw the newer token.

In SQL, add a `fence` column, and do the check and the write in one statement:

```ts
import { DatabaseSync } from 'node:sqlite';

import type { FencingToken } from '@zukhruf/fencing';

const database = new DatabaseSync('shop.db', { readBigInts: true });
database.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    product  TEXT PRIMARY KEY,
    quantity INTEGER NOT NULL,
    fence    INTEGER NOT NULL DEFAULT 0
  )
`);

/** Reserves one item, unless a holder with a newer token wrote this product. */
function reserve(product: string, token: FencingToken): boolean {
  const { changes } = database
    .prepare(
      `UPDATE stock SET quantity = quantity - 1, fence = ?
       WHERE product = ? AND fence <= ? AND quantity > 0`,
    )
    .run(token.value, product, token.value);
  return Number(changes) > 0;
}
```

Follow these rules:

- **Refuse only lower tokens.** Use `fence <= :token`, not `fence < :token`. One holder can write two times with the same token.
- **Do the check and the write in one statement.** If you read the fence first and write later, a stale write can occur between the two.
- **Compare the tokens as integers.** Use a 64-bit integer column, for example `INTEGER` in SQLite or `BIGINT` in PostgreSQL. In `node:sqlite`, bind `token.value` (a `bigint`), and open the database with `readBigInts: true`.
- **Do not make a token a JavaScript number.** A number above 2^53 loses its last digits, and the tokens of `EpochTokenSource` get there from epoch 2^21. `JSON.stringify` refuses a `bigint`. Send the decimal text of the token instead.

Fencing tokens protect only a fenced resource. If a stale holder sends an email or calls an API that does not compare tokens, the token does not stop it.

## A token as text

`token.toString()` gives the decimal digits of the token, for example `"34"`. `FencingToken.parse(text)` reads that text back. It returns `null` for each other text, as `URL.parse` does:

```ts
import { FencingToken } from '@zukhruf/fencing';

FencingToken.parse('34'); // FencingToken { value: 34n }
FencingToken.parse('-1'); // null: a token is never negative
FencingToken.parse(' 34'); // null
FencingToken.parse('0x22'); // null
```

`BigInt` alone accepts more: `BigInt('')` is `0n`, `BigInt(' 34')` is `34n`, and `BigInt('0x22')` is `34n`. Thus use `parse` for each token that you read from a message or a header.

## One key, one token source

A token has no name of its key and no name of its token source. Two tokens of different keys, or of different token sources, cannot be compared. A counter in memory and a counter in a file can both give token 7 to two different holders.

Thus a fenced resource compares the tokens of one key, from one token source. Give each protected row, file, or object its own key. Give all issuers of that key the same token source.

## Token sources

A **token source** makes the tokens of an issuer. The issuer asks it for the next token of a key, one time for each grant. The issuer never asks for two tokens of one key at the same time: a mutex holds the key while it asks.

| Token source                | Tokens                                                                                                  | Durable                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `CounterTokenSource`        | 1, 2, 3, … in memory, one counter for all keys.                                                         | No. It starts again at 1 with the process. |
| `MonotonicClockTokenSource` | The monotonic clock of the process (`process.hrtime.bigint()`). Each token is higher than the last one. | No. Its order holds only in one process.   |
| `FileTokenSource`           | 1, 2, 3, … for each key, in a file `<key>.fence` in the directory that you give.                        | Yes.                                       |
| `EpochTokenSource`          | `epoch << 32 \| counter`. The counter starts at 1 and is one counter for all keys.                      | Yes, when each start uses a higher epoch.  |

Select a token source:

- **The resource does not live longer than the process**, for example a cache in memory: use `CounterTokenSource`.
- **Worker threads of one process share a resource**: use `MonotonicClockTokenSource`. All threads of a process read the same monotonic clock, so a thread gets a higher token than the thread that held the key before it, with no shared memory.
- **The resource is durable**, for example a database or a file: use `FileTokenSource`. The resource keeps the highest token after your process stops. A source in memory starts again at 1, and then the resource refuses each new write.
- **A leader issues the grants, and a new leader can take over**: use `EpochTokenSource` with the epoch of the leader's term, for example `term.epoch` of `@zukhruf/election`.

```ts
import { FileTokenSource } from '@zukhruf/fencing';

const tokens = new FileTokenSource('/var/lib/my-app/fences');
const token = await tokens.next('product:42');
```

`FileTokenSource` makes the directory if it is absent. It keeps the counter of each key as decimal text, and it replaces the file in one step and syncs it to the disk before it gives the token. On Linux and macOS, a power loss cannot make it give one token two times. The name of the file comes from the key with `safeFileName` of `@zukhruf/fs`. Processes that use earlier versions of `@zukhruf/mutex` find the same files.

`EpochTokenSource` puts the epoch in the high 32 bits and the counter in the low 32 bits, as ZooKeeper does in its `zxid`. Each token of a newer epoch is higher than each token of an older epoch. A new leader thus outranks all grants of the leader before it. The epoch must be from 0 to 2^31 − 1, so that each token fits a signed 64-bit integer. One epoch gives at most 2^32 − 1 tokens. After that, `next` throws a `RangeError`.

## A fenced lease

An issuer of fenced access gives the holder a `FencedLease`: a `Lease` of `@zukhruf/lease` that also has a `token`. The signal warns the holder. The token protects the resource.

```ts
import type { FencedLease } from '@zukhruf/fencing';

async function sell(lease: FencedLease, product: string) {
  lease.signal.throwIfAborted();
  if (!reserve(product, lease.token)) throw new Error('A newer holder wrote.');
}
```

## Why not a random value, a UUID, or a time

A resource can refuse a stale holder only when the tokens of one key are strictly in the order of the grants. A random value or a UUID has no order. A UUIDv7 has an order by time only to the millisecond, and it is random in that millisecond. In a test in Node 26, 50,160 of 100,000 UUIDv7 values from one thread were lower than the value before them. A clock of the wall can go back. See [ADR 0001](./docs/adr/0001-a-fencing-token-is-a-number-the-resource-checks.md).

## The same concepts in other systems

| This package                  | Other systems                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Fencing token                 | Kleppmann, "How to do distributed locking" (2016); Chubby sequencer; Hazelcast `FencedLock` fence; etcd revision |
| The resource checks the token | Chubby `CheckSequencer()`; an SQL `UPDATE … WHERE fence <= ?`                                                    |
| `EpochTokenSource`            | ZooKeeper `zxid`: epoch in the high 32 bits, counter in the low 32 bits; Raft term; Kafka leader epoch           |
| `FencedLease`                 | Hazelcast `FencedLock`; etcd `concurrency.Mutex` with its session and the revision of its key                    |
