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

/** A coordinator that started after a failover, and a way to connect scripted peers to it. */
function coordinatorAfterFailover(graceWindow: number) {
	const coordinator = new LockCoordinator({ tokens: new CounterTokenSource(), graceWindow });
	const connect = () => {
		const peer = scriptedPeer<LockResponse, LockRequest>();
		coordinator.serve(peer.connection);
		return peer;
	};
	return { coordinator, connect };
}

/** Resolves `'granted'` if `lease` arrives within `milliseconds`, otherwise `'waiting'`. */
async function grantedWithin(lease: Promise<unknown>, milliseconds: number) {
	const timeout = Promise.withResolvers<'waiting'>();
	const timer = setTimeout(() => timeout.resolve('waiting'), milliseconds);
	try {
		return await Promise.race([lease.then(() => 'granted' as const), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe('Grace window after a failover', () => {
	test('an acquire that arrives during the grace window is granted only after it ends', async (t) => {
		// Arrange
		const { connect } = coordinatorAfterFailover(200);
		const waiter = connect();

		// Act
		waiter.deliver({ op: 'acquire', id: 'w', key: 'product:42' });
		await delay(100);
		const duringGrace = [...waiter.sent];

		// Assert
		assert.deepEqual(duringGrace, [], 'Nothing may be granted during the grace window');
		await waitUntil(
			t,
			() => waiter.sent.some((response) => response.op === 'granted'),
			'The acquire must be granted once the grace window ends',
		);
	});

	test('a reassert that arrives after the grace window is refused', async (t) => {
		// Arrange: a holder reconnects too late, for example after a freeze.
		const { connect } = coordinatorAfterFailover(50);
		const holder = connect();
		await delay(100);

		// Act
		holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '7' });

		// Assert
		await waitUntil(t, () => holder.sent.length > 0, 'The coordinator must answer the reassert');
		assert.deepEqual(holder.sent, [{ op: 'rejected', id: 'h' }]);
	});

	test('a reasserted key stays with its holder, ahead of an acquire that arrived first', async () => {
		// Arrange: a waiter's acquire arrives before the holder reconnects.
		const { coordinator, connect } = coordinatorAfterFailover(100);
		const waiter = connect();
		const holder = connect();
		waiter.deliver({ op: 'acquire', id: 'w', key: 'product:42' });
		holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });

		// Act: the grace window ends while the holder still has the key.
		await delay(200);
		const afterGrace = [...waiter.sent];
		holder.deliver({ op: 'release', id: 'h' });

		// Assert: the waiter gets the key only after the holder releases it.
		assert.deepEqual(afterGrace, [], 'The waiter was granted a key that a holder reasserted');
		assert.equal(
			await grantedWithin(coordinator.acquire('other-key'), settle),
			'granted',
			'Other keys must not wait',
		);
		await delay(settle);
		assert.equal(waiter.sent[0]?.op, 'granted', 'The waiter must get the key after the release');
	});

	test('when two holders reassert one key, the newer token keeps it', async (t) => {
		// Arrange
		const { coordinator, connect } = coordinatorAfterFailover(150);
		const older = connect();
		const newer = connect();

		// Act
		older.deliver({ op: 'reassert', id: 'o', key: 'product:42', token: '5' });
		newer.deliver({ op: 'reassert', id: 'n', key: 'product:42', token: '9' });
		await waitUntil(t, () => older.sent.length > 0, 'The older claim must be answered');
		older.drop();
		await delay(200);

		// Assert: the older claim is refused, and its disconnect does not free the newer holder's key.
		assert.deepEqual(older.sent, [{ op: 'rejected', id: 'o' }]);
		assert.deepEqual(newer.sent, [], 'The newer claim must not be refused');
		const next = coordinator.acquire('product:42');
		assert.equal(await grantedWithin(next, settle), 'waiting', 'The newer holder must still have the key');
		newer.deliver({ op: 'release', id: 'n' });
		assert.equal(await grantedWithin(next, 1000), 'granted', 'The key must be free after the newer holder releases it');
	});
});
