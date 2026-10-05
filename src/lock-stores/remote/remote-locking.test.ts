import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import type { Connection, ConnectionHandlers } from './connection.ts';
import { LockCoordinator } from './lock-coordinator.ts';
import type { LockRequest, LockResponse } from './protocol.ts';
import { RemoteLockClient } from './remote-lock-client.ts';

/** One end of a connection whose peer is driven by the test. */
function scriptedPeer<Outgoing, Incoming>(
	onSend: (message: Outgoing) => Promise<void> = async () => {},
) {
	const sent: Outgoing[] = [];
	let handlers: ConnectionHandlers<Incoming> | undefined;
	const connection: Connection<Outgoing, Incoming> = {
		async send(message) {
			sent.push(message);
			await onSend(message);
		},
		listen(listeners) {
			handlers = listeners;
		},
		ref() {},
		unref() {},
		close() {},
	};
	return {
		connection,
		sent,
		deliver: (message: Incoming) => handlers?.message(message),
		drop: () => handlers?.close(),
	};
}

describe('Remote locking protocol', () => {
	test('a resent acquire is granted once, and its release frees the key', async (t) => {
		// Arrange: a client's acquire reaches the coordinator twice, as after a reconnect.
		const coordinator = new LockCoordinator({ tokens: new CounterTokenSource() });
		const client = scriptedPeer<LockResponse, LockRequest>();
		coordinator.serve(client.connection);
		const deadline = Promise.withResolvers<'still held'>();
		const timer = setTimeout(() => deadline.resolve('still held'), 1000);

		try {
			// Act
			client.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
			client.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
			await waitUntil(t, () => client.sent.length > 0, 'The first acquire must be granted');
			client.deliver({ op: 'release', id: 'a' });
			await delay(settle);

			// Assert: one grant, and the key is free again after that one release.
			assert.equal(
				client.sent.filter((response) => response.op === 'granted').length,
				1,
				'The same request id must be granted only once',
			);
			const next = await Promise.race([
				coordinator.acquire('product:42').then(() => 'granted' as const),
				deadline.promise,
			]);
			assert.equal(next, 'granted', 'Releasing the request must free the key for the next caller');
		} finally {
			clearTimeout(timer);
		}
	});

	test('a lease released while its connection drops is not reasserted on the next connection', async (t) => {
		// Arrange: the first connection grants the key, then drops while the release is in flight.
		const releaseStalls = Promise.withResolvers<void>();
		const first = scriptedPeer<LockRequest, LockResponse>(async (request) => {
			if (request.op === 'acquire') {
				queueMicrotask(() => first.deliver({ op: 'granted', id: request.id, token: '1' }));
			}
			if (request.op === 'release') {
				first.drop();
				await releaseStalls.promise;
			}
		});
		const second = scriptedPeer<LockRequest, LockResponse>();
		const connections = [first.connection, second.connection];
		const client = new RemoteLockClient({ connect: async () => connections.shift() });
		const lease = await client.acquire('product:42');

		try {
			// Act: release, and let the client reconnect while that release is still being sent.
			void lease[Symbol.asyncDispose]();
			await waitUntil(t, () => connections.length === 0, 'The client must reconnect');
			await delay(settle);

			// Assert: the released lease is not brought back on the new connection.
			assert.deepEqual(
				second.sent.filter((request) => request.op === 'reassert'),
				[],
				'A lease being released must never be reasserted after a reconnect',
			);
		} finally {
			releaseStalls.resolve();
			client.close();
		}
	});
});
