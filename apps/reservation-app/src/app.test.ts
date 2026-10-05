import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Mutex, TicketQueueFileStore } from '@zukhruf/mutex';

import { createApp } from './create-app.ts';
import { FencedStock } from './fenced-stock.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const createAppUrl = new URL('./create-app.ts', import.meta.url).href;
const fencedStockUrl = new URL('./fenced-stock.ts', import.meta.url).href;

/** Runs one copy of the app in its own process, sends one reservation, and gives back the status. */
async function reserveFromOwnProcess(directory: string): Promise<number> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
				import { join } from 'node:path';
				import { Mutex, TicketQueueFileStore } from '@zukhruf/mutex';
				import { createApp } from ${JSON.stringify(createAppUrl)};
				import { FencedStock } from ${JSON.stringify(fencedStockUrl)};

				const directory = ${JSON.stringify(directory)};
				const app = createApp({
					mutex: new Mutex(new TicketQueueFileStore(directory)),
					stock: new FencedStock(join(directory, 'inventory.db')),
				});
				const response = await app.request('/reserve', { method: 'POST' });
				process.stdout.write(String(response.status));
			`,
    ],
    { cwd: appRoot },
  );
  return Number(stdout.trim());
}

describe('Reservation endpoint', () => {
  test(
    'two requests to the reservation endpoint cannot both reserve the last item',
    { timeout: 5000 },
    async () => {
      // Arrange: the app wired like production, over its own directory, with one item left.
      const directory = await mkdtemp(join(tmpdir(), 'app-test-'));
      const stock = new FencedStock(join(directory, 'inventory.db'));
      stock.seed('product:42', 1);
      const app = createApp({
        mutex: new Mutex(new TicketQueueFileStore(directory)),
        stock,
      });

      // Act: both requests enter the reservation endpoint concurrently.
      const requests = [
        app.request('/reserve', { method: 'POST' }),
        app.request('/reserve', { method: 'POST' }),
      ];

      try {
        const responses = await Promise.all(requests);
        const bodies = (await Promise.all(
          responses.map((response) => response.json()),
        )) as Array<{ outcome: string }>;

        // Assert: exactly one caller gets the item, whichever arrives first.
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [201, 409],
          'With one item available, exactly one request must return 201 and the other 409',
        );
        assert.deepEqual(
          bodies.map((body) => body.outcome).sort(),
          ['reserved', 'sold-out'],
          'The losing request must be told the product sold out, not that its lock was stale',
        );
        assert.equal(
          stock.quantity('product:42'),
          0,
          'The single available item must be consumed exactly once',
        );
      } finally {
        await Promise.allSettled(requests);
        stock.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test(
    'two app processes that share a directory reserve the last item only once',
    { timeout: 15000 },
    async () => {
      // Arrange: one item in the shared stock, and two copies of the app, each in its own process.
      const directory = await mkdtemp(join(tmpdir(), 'app-test-'));
      const stock = new FencedStock(join(directory, 'inventory.db'));
      stock.seed('product:42', 1);

      try {
        // Act: both processes reserve at the same time.
        const started = performance.now();
        const statuses = await Promise.all([
          reserveFromOwnProcess(directory),
          reserveFromOwnProcess(directory),
        ]);
        const elapsed = performance.now() - started;

        // Assert: the processes share the lock and the stock, so only one reservation succeeds.
        // Each request holds the key for 1 s, so a shared lock runs them one after the other.
        assert.ok(
          elapsed >= 1900,
          `Both requests finished in ${elapsed.toFixed(0)} ms; with a shared lock they take at least 2 s`,
        );
        assert.deepEqual(
          statuses.sort(),
          [201, 409],
          'Across two app processes, exactly one request must return 201 and the other 409',
        );
        assert.equal(
          stock.quantity('product:42'),
          0,
          'The single item must be consumed exactly once',
        );
      } finally {
        stock.close();
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        });
      }
    },
  );
});
