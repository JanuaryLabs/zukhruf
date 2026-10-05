import { Hono } from 'hono';
import { setTimeout as delay } from 'node:timers/promises';
import type { FencedStock } from './fenced-stock.ts';
import type { Mutex } from 'mutex';

export interface AppDependencies {
	mutex: Mutex;
	stock: FencedStock;
}

const product = 'product:42';

export function createApp({ mutex, stock }: AppDependencies) {
	const app = new Hono();

	app.post('/reserve', async (c) => {
		const outcome = await mutex.acquire(product, async (lease) => {
			await delay(1000);
			return stock.reserve(product, lease.token);
		});

		return c.json(
			{ reserved: outcome === 'reserved', outcome },
			outcome === 'reserved' ? 201 : 409,
		);
	});

	return app;
}
