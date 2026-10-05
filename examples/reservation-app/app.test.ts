import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FencedStock } from './fenced-stock.ts';
import { Mutex, TicketQueueFileStore } from 'mutex';
import { createApp } from './create-app.ts';

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
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
