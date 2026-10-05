# Recipe: Protect a database from stale holders

**Use case.** A holder can lose its key and not know it: its process froze, or a failover occurred. When it continues, it can write over the work of a newer holder. You want the database to refuse that late write.

**What you need.** The lease's [fencing token](../concepts/fencing-tokens.md) and a database that compares tokens. Any lock store works.

## The steps

1. Add a `fence` column to the table that you protect.
2. In each write, send `lease.token` and refuse the write if the token is lower than `fence`.
3. Do the compare and the write in **one** SQL statement.
4. If the database is durable, give the lock store a **durable** token source.

## The program

This program shows a stale holder. Holder A gets the key and keeps its token. Holder B gets the key later and reserves an item. Then A writes late with its old token.

```ts title="fenced-database.ts"
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FileTokenSource, MemoryStore, Mutex, type FencingToken } from '@zukhruf/mutex';

const directory = await mkdtemp(join(tmpdir(), 'fenced-'));
const database = new DatabaseSync(join(directory, 'shop.db'), { readBigInts: true });
database.exec(`
	CREATE TABLE stock (
		product  TEXT PRIMARY KEY,
		quantity INTEGER NOT NULL,
		fence    INTEGER NOT NULL DEFAULT 0
	)
`);
database.prepare('INSERT INTO stock (product, quantity) VALUES (?, ?)').run('product:42', 2);

/** Reserves one item, unless a newer holder already wrote this product. */
function reserve(product: string, token: FencingToken): boolean {
	const { changes } = database
		.prepare(
			`UPDATE stock SET quantity = quantity - 1, fence = ?
			 WHERE product = ? AND fence <= ? AND quantity > 0`,
		)
		.run(token.value, product, token.value);
	return Number(changes) > 0;
}

// The database is durable, so the tokens must be durable too.
const mutex = new Mutex(
	new MemoryStore({ tokens: new FileTokenSource(join(directory, 'fences')) }),
);

// Holder A gets the key. For this demo, it keeps its token after the release.
const staleToken = await mutex.acquire('product:42', async (lease) => lease.token);

// Holder B gets the key later and reserves an item.
const newer = await mutex.acquire('product:42', async (lease) =>
	reserve('product:42', lease.token),
);

// Holder A continues and writes with its old token.
const late = reserve('product:42', staleToken);

console.log({ newer, late, staleToken: staleToken.value });
database.close();
await rm(directory, { recursive: true, force: true });
```

Output:

```
{ newer: true, late: false, staleToken: 1n }
```

## Why it works

B's token is 2, so B's write sets `fence` to 2. A's token is 1. The condition `fence <= 1` is false, so the database changes no row, and A's write is refused.

The compare and the write are in one statement. Thus no other write can occur between them.

## Things to know

- **Use `fence <= :token`, not `<`.** One holder can write two times with the same token.
- **Durable database, durable tokens.** `CounterTokenSource` starts again at 1 after a restart. Then the database refuses every new write. `FileTokenSource` keeps its count in files. The file lock stores, `SqliteStore`, and `SocketStore` already use durable tokens.
- **Only the fenced resource is protected.** If a stale holder sends an email, the token does not stop it.
- **A full example** is in [`apps/reservation-app/src/fenced-stock.ts`](../../../../apps/reservation-app/src/fenced-stock.ts). It also tells "sold out" apart from "stale".
- **A real stale holder** is tested in `src/lock-stores/socket/socket-store.test.ts`: a process frozen with `SIGSTOP` past a failover. A fenced register refuses its write as `'stale'`.
