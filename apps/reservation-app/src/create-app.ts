import { setTimeout as delay } from 'node:timers/promises';

import { Hono } from 'hono';

import type { Mutex } from '@zukhruf/mutex';

import type { FencedStock } from './fenced-stock.ts';

export interface AppDependencies {
  mutex: Mutex;
  stock: FencedStock;
}

const product = 'product:42';

/** The status nginx logs for a client that closed its request before the answer. */
const clientClosedRequest = 499;

export function createApp({ mutex, stock }: AppDependencies) {
  const app = new Hono();

  app.post('/reserve', async (c) => {
    const { signal } = c.req.raw;
    try {
      const outcome = await mutex.acquire(
        product,
        async (lease) => {
          await delay(1000);
          return stock.reserve(product, lease.token);
        },
        { signal },
      );

      return c.json(
        { reserved: outcome === 'reserved', outcome },
        outcome === 'reserved' ? 201 : 409,
      );
    } catch (error) {
      // The client left while it waited for the key, so nothing was reserved and nobody reads the answer.
      if (error === signal.reason) {
        return new Response(null, { status: clientClosedRequest });
      }
      throw error;
    }
  });

  return app;
}
