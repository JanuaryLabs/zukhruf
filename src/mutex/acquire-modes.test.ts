import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import { storeCases, type StoreHost } from '../testing/store-cases.ts';
import { waitUntil } from '../testing/wait-until.ts';
import { startWorker } from '../testing/worker-process.ts';
import { MemoryStore } from '../lock-stores/memory/memory-store.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

const mutexUrl = new URL('./mutex.ts', import.meta.url);
const modesUrl = new URL('./acquire-modes/modes.ts', import.meta.url);
const storeCasesUrl = new URL('../testing/store-cases.ts', import.meta.url);

/** Holds `key` until the returned `release` is called. */
async function hold(mutex: Mutex, key: string) {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const held = mutex.acquire(key, async () => {
		entered.resolve();
		await finish.promise;
	});
	await entered.promise;
	return {
		release: async () => {
			finish.resolve();
			await held;
		},
	};
}

/** Resolves `'done'` if `work` settles within `milliseconds`, otherwise `'still waiting'`. */
async function within(work: Promise<unknown>, milliseconds: number) {
	const timeout = Promise.withResolvers<'still waiting'>();
	const timer = setTimeout(() => timeout.resolve('still waiting'), milliseconds);
	try {
		return await Promise.race([work.then(() => 'done' as const), timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

for (const store of storeCases) {
	describe(`Acquire modes with ${store.name}`, () => {
		test('skipIfBusy gives up at once while another holder has the key, and does not run the task', { timeout: 5000 }, async () => {
			// Arrange
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const holder = await hold(mutex, 'report:daily');
			let ran = false;

			try {
				// Act
				const result = await mutex.acquire(
					'report:daily',
					async () => {
						ran = true;
						return 'report';
					},
					{ mode: Modes.skipIfBusy() },
				);

				// Assert
				assert.deepEqual(result, { acquired: false });
				assert.equal(ran, false, 'A skipped caller must not run its task');
			} finally {
				await holder.release();
			}
		});

		test('skipIfBusy acquires a free key and gives back the task value', async () => {
			// Arrange
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);

			// Act
			const result = await mutex.acquire('report:daily', async () => 'report', {
				mode: Modes.skipIfBusy(),
			});

			// Assert
			assert.deepEqual(result, { acquired: true, value: 'report' });
		});

		test('skipIfBusy({ waitAtMost }) gives up after the limit while the key stays busy', { timeout: 5000 }, async () => {
			// Arrange
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const holder = await hold(mutex, 'report:daily');

			try {
				// Act
				const started = performance.now();
				const result = await mutex.acquire('report:daily', async () => 'report', {
					mode: Modes.skipIfBusy({ waitAtMost: 100 }),
				});
				const waited = performance.now() - started;

				// Assert
				assert.deepEqual(result, { acquired: false });
				assert.ok(waited >= 90, `The caller gave up after ${waited.toFixed(0)} ms, before its 100 ms limit`);
			} finally {
				await holder.release();
			}
		});

		test('skipIfBusy({ waitAtMost }) acquires when the key is released within the limit', { timeout: 5000 }, async () => {
			// Arrange
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const holder = await hold(mutex, 'report:daily');

			// Act
			const attempt = mutex.acquire('report:daily', async () => 'report', {
				mode: Modes.skipIfBusy({ waitAtMost: 2000 }),
			});
			await delay(50);
			await holder.release();

			// Assert
			assert.deepEqual(await attempt, { acquired: true, value: 'report' });
		});

		test('a caller that gave up does not block the callers after it', { timeout: 5000 }, async () => {
			// Arrange: a holder, a caller that gives up, and a caller that waits behind it.
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const holder = await hold(mutex, 'report:daily');
			const gaveUp = await mutex.acquire('report:daily', async () => 'report', {
				mode: Modes.skipIfBusy({ waitAtMost: 50 }),
			});
			const waiter = mutex.acquire('report:daily', async () => 'report');

			// Act
			await holder.release();

			// Assert
			assert.deepEqual(gaveUp, { acquired: false });
			assert.equal(
				await within(waiter, 2000),
				'done',
				'The waiting caller must get the key; the caller that gave up must not keep it',
			);
		});

		test("a key's default mode applies, and one call can override it", { timeout: 5000 }, async () => {
			// Arrange: callers of this key skip by default.
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const report = mutex.key('report:daily', { mode: Modes.skipIfBusy() });
			const holder = await hold(mutex, report.name);

			// Act: one caller uses the default, another overrides it and waits.
			const skipped = await report.run(async () => 'cron run');
			const waited = report.run(async () => 'admin run', { mode: Modes.wait() });
			await delay(50);
			await holder.release();

			// Assert
			assert.deepEqual(skipped, { acquired: false });
			assert.equal(await waited, 'admin run', 'An override to wait must run the task and give its value');
		});
	});
}

describe('Acquire mode result types', () => {
	test('the result type follows the acquire mode', async () => {
		const mutex = new Mutex(new MemoryStore());

		const value: number = await mutex.acquire('k', async () => 1);
		const result = await mutex.acquire('k', async () => 1, { mode: Modes.skipIfBusy() });
		// @ts-expect-error a mode that may give up must be checked before its value is read
		void result.value;
		const checked: number = result.acquired ? result.value : 0;

		const key = mutex.key('k', { mode: Modes.skipIfBusy() });
		const viaKey = await key.run(async () => 'x');
		// @ts-expect-error the key's default mode may give up
		void viaKey.value;
		const overridden: string = await key.run(async () => 'x', { mode: Modes.wait() });

		assert.deepEqual([value, checked, viaKey, overridden], [1, 1, { acquired: true, value: 'x' }, 'x']);
	});

	test('a negative or infinite time limit is refused', () => {
		assert.throws(() => Modes.skipIfBusy({ waitAtMost: -1 }), RangeError);
		assert.throws(() => Modes.skipIfBusy({ waitAtMost: Number.POSITIVE_INFINITY }), RangeError);
	});
});

/** A child or thread that skips while its host holds the key, then reports both results. */
const skipperBody = `
	const atOnce = await mutex.acquire('report:daily', async () => 'ran', { mode: Modes.skipIfBusy() });
	const afterLimit = await mutex.acquire('report:daily', async () => 'ran', { mode: Modes.skipIfBusy({ waitAtMost: 100 }) });
	report({ type: 'results', atOnce, afterLimit });
`;

for (const store of storeCases.filter((candidate) => candidate.reach === 'host' || candidate.reach === 'process-tree')) {
	describe(`Acquire modes across processes with ${store.name}`, () => {
		test('a process that skips while another process holds gives up, and leaves the key free', { timeout: 10000 }, async (t) => {
			// Arrange: this process holds the key; a child (kept alive) tries to skip.
			await using directory = await scratchDirectory();
			await using host = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const holder = await hold(mutex, 'report:daily');
			await using child = startWorker(
				`
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { Modes } from ${JSON.stringify(modesUrl.href)};
					import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};
					setInterval(() => {}, 1000);
					const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory.path)}));
					const report = (message) => process.send(message);
					${skipperBody}
				`,
				'skipper',
				{ host },
			);

			// Act
			await waitUntil(t, () => child.has('results'), `The child must report.\n${child.stderr}`, 5000);
			await holder.release();

			// Assert: both attempts gave up, and no grant was left with the child.
			assert.deepEqual(
				{ atOnce: child.find('results')?.atOnce, afterLimit: child.find('results')?.afterLimit },
				{ atOnce: { acquired: false }, afterLimit: { acquired: false } },
			);
			assert.equal(
				await within(mutex.acquire('report:daily', async () => 'next'), 2000),
				'done',
				'The key must be free after the holder releases it; the child that gave up must not keep it',
			);
		});
	});
}

for (const store of storeCases.filter((candidate) => candidate.reach === 'process')) {
	describe(`Acquire modes across threads with ${store.name}`, () => {
		test('a thread that skips while another thread holds gives up, and leaves the key free', { timeout: 10000 }, async () => {
			// Arrange: the main thread holds the key; a worker (kept alive) tries to skip.
			await using directory = await scratchDirectory();
			await using host: StoreHost = store.open(directory.path);
			const mutex = new Mutex(host.store);
			const holder = await hold(mutex, 'report:daily');
			const thread = new Worker(
				`
					(async () => {
						const { parentPort } = await import('node:worker_threads');
						const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
						const { Modes } = await import(${JSON.stringify(modesUrl.href)});
						const { createThreadStore } = await import(${JSON.stringify(storeCasesUrl.href)});
						setInterval(() => {}, 1000);
						const mutex = new Mutex(createThreadStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory.path)}));
						const report = (message) => parentPort.postMessage(message);
						${skipperBody}
					})();
				`,
				{ eval: true },
			);
			host.adoptThread(thread);
			const results = new Promise<{ atOnce: unknown; afterLimit: unknown }>((resolve) =>
				thread.on('message', (message) => {
					if (message?.type === 'results') resolve(message);
				}),
			);

			try {
				// Act
				const reported = await results;
				await holder.release();

				// Assert
				assert.deepEqual(
					{ atOnce: reported.atOnce, afterLimit: reported.afterLimit },
					{ atOnce: { acquired: false }, afterLimit: { acquired: false } },
				);
				assert.equal(
					await within(mutex.acquire('report:daily', async () => 'next'), 2000),
					'done',
					'The key must be free after the holder releases it; the thread that gave up must not keep it',
				);
			} finally {
				await thread.terminate();
			}
		});
	});
}
