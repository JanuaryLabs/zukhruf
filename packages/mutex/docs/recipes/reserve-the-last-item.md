# Recipe: Stop two requests from selling the last item

**Use case.** One web server process sells stock. Two customers ask for the last item at the same time. Only one customer must get it.

**Lock store.** [MemoryStore](../stores/memory-store.md). One process does all the writes, so the reach is one instance.

## The problem

The endpoint reads the stock, waits for the database, and then writes the stock. Two requests can both read `1` before one of them writes `0`.

```ts title="without-mutex.ts"
import { Hono } from 'hono';
import { setTimeout as delay } from 'node:timers/promises';

let stock = 1;
const app = new Hono();

app.post('/reserve', async (c) => {
	if (stock === 0) return c.json({ reserved: false }, 409);
	await delay(10); // The database call that saves the reservation.
	stock -= 1;
	return c.json({ reserved: true }, 201);
});

const responses = await Promise.all([
	app.request('/reserve', { method: 'POST' }),
	app.request('/reserve', { method: 'POST' }),
]);
console.log(responses.map((response) => response.status), { stock });
```

Output:

```
[ 201, 201 ] { stock: -1 }
```

Both customers got the item, and the stock is below zero.

## The solution

Put the read and the write inside `mutex.acquire`. Use one key for each product.

```ts title="reserve.ts"
import { Hono } from 'hono';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore, Mutex } from '@zukhruf/mutex';

let stock = 1;
const mutex = new Mutex(new MemoryStore());
const app = new Hono();

app.post('/reserve', async (c) => {
	const reserved = await mutex.acquire('product:42', async () => {
		if (stock === 0) return false;
		await delay(10); // The database call that saves the reservation.
		stock -= 1;
		return true;
	});
	return c.json({ reserved }, reserved ? 201 : 409);
});

const responses = await Promise.all([
	app.request('/reserve', { method: 'POST' }),
	app.request('/reserve', { method: 'POST' }),
]);
console.log(responses.map((response) => response.status), { stock });
```

Output:

```
[ 201, 409 ] { stock: 0 }
```

## Why it works

The second request waits at `mutex.acquire` until the first request finishes its task. Then the second request reads `0` and returns `false`. The task returns a value, and `acquire` gives that value back to you.

Use one `Mutex` object for the whole process. Two `MemoryStore` objects do not share their locks.

## Next steps

- More than one process sells the same stock: see [Several app instances on one host](./several-instances-on-one-host.md).
- The stock is in a database that more than one service writes: see [Protect a database from stale holders](./fence-a-database.md).
