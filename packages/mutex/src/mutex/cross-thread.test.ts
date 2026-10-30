import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { describe, test } from '@zukhruf/testing/node';

import { isRecord } from '../shared/is-record.ts';
import { newProcessTimeout } from '../testing/new-process-timeout.ts';
import {
  type StoreCase,
  type StoreHost,
  deadlineFor,
  reaches,
  settle,
  storeCases,
  timeoutForGrants,
} from '../testing/store-cases.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

const mutexUrl = new URL('./mutex.ts', import.meta.url);
const storeCasesUrl = new URL('../testing/store-cases.ts', import.meta.url);

/**
 * Worker source that builds the store's thread side, then runs `body` with
 * `mutex`, `parentPort` and `workerData` in scope. Only dynamic imports, because
 * an eval worker is CommonJS or ESM depending on the process that starts it.
 */
const threadSource = (storeName: string, location: string, body: string) => `
	(async () => {
		const { parentPort, workerData } = await import('node:worker_threads');
		const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
		const { createThreadStore } = await import(${JSON.stringify(storeCasesUrl.href)});
		const mutex = new Mutex(createThreadStore(${JSON.stringify(storeName)}, ${JSON.stringify(location)}));
		${body}
	})();
`;

/** Starts a worker thread that the host adopts before it can ask for a key. */
function startThread(host: StoreHost, source: string, workerData?: unknown) {
  const thread = new Worker(source, { eval: true, workerData });
  host.adoptThread(thread);
  return thread;
}

/** Four threads add 1 to a shared counter 20 times each, reading and writing around an `await`. */
async function incrementFromFourThreads(store: StoreCase, location: string) {
  await using host = store.open(location);
  const mutex = new Mutex(host.store);
  // [counter, holders inside the critical section, overlaps seen]
  const shared = new Int32Array(new SharedArrayBuffer(12));
  const increment = async () => {
    if (Atomics.add(shared, 1, 1) !== 0) Atomics.add(shared, 2, 1);
    const value = shared[0]!;
    await nextTurn();
    shared[0] = value + 1;
    Atomics.sub(shared, 1, 1);
  };
  const body = `
		const shared = workerData;
		for (let i = 0; i < 20; i++) {
			await mutex.acquire('counter', async () => {
				if (Atomics.add(shared, 1, 1) !== 0) Atomics.add(shared, 2, 1);
				const value = shared[0];
				await new Promise((resolve) => setImmediate(resolve));
				shared[0] = value + 1;
				Atomics.sub(shared, 1, 1);
			});
		}
	`;
  const exits = [1, 2, 3].map(() =>
    once(
      startThread(host, threadSource(store.name, location, body), shared),
      'exit',
    ),
  );
  for (let i = 0; i < 20; i++) await mutex.acquire('counter', increment);
  await Promise.all(exits);
  return { counter: shared[0], overlaps: shared[2] };
}

void describe.each(
  storeCases.filter((candidate) => candidate.reach === 'process'),
  (store) =>
    describe(`Cross-thread mutex with ${store.name}`, () => {
      test(
        'a thread waits while another thread of the same process holds the key',
        { timeout: timeoutForGrants(store, 2) },
        async (t) => {
          // Arrange: the main thread holds the key.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const finishMain = Promise.withResolvers<void>();
          const held = mutex.acquire('product:42', () => finishMain.promise);
          const events: string[] = [];
          const thread = startThread(
            host,
            threadSource(
              store.name,
              fixture.location,
              `parentPort.postMessage('requested');
						 await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
            ),
          );
          thread.on('message', (event) => {
            if (typeof event === 'string') events.push(event);
          });

          try {
            // Act: the thread asks for the same key while the main thread holds it.
            await t.waitFor(
              () =>
                assert.ok(
                  events.includes('requested'),
                  'The thread must start',
                ),
              { interval: 5, timeout: newProcessTimeout },
            );
            await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
            const enteredWhileHeld = events.includes('entered');
            finishMain.resolve();
            await held;

            // Assert
            assert.equal(
              enteredWhileHeld,
              false,
              'The thread entered while the main thread held the key',
            );
            await t.waitFor(
              () =>
                assert.ok(
                  events.includes('entered'),
                  'The thread must enter once the main thread releases',
                ),
              {
                interval: 5,
                timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
              },
            );
          } finally {
            finishMain.resolve();
            await thread.terminate();
          }
        },
      );

      test(
        'a thread that dies while holding the key does not block the next caller',
        { timeout: timeoutForGrants(store, 2) },
        async () => {
          // Arrange: a worker thread enters and stays inside its callback.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const holder = startThread(
            host,
            threadSource(
              store.name,
              fixture.location,
              `setInterval(() => {}, 1000);
						 await mutex.acquire('product:42', async () => {
							 parentPort.postMessage('held');
							 await new Promise(() => {});
						 });`,
            ),
          );
          const held = once(holder, 'message');
          const mutex = new Mutex(host.store);

          try {
            await held;
            const limit = deadlineFor(store, 2000, { grants: 1, releases: 1 });
            const deadline = delay(limit, null, { ref: false });
            const next = mutex.acquire('product:42', async () => true);

            // Act: the holding thread is terminated without releasing.
            await holder.terminate();

            // Assert: the waiter is granted instead of waiting forever.
            assert.equal(
              await Promise.race([next, deadline]),
              true,
              `The waiter must acquire within ${limit} ms after the holding thread died`,
            );
          } finally {
            await holder.terminate();
          }
        },
      );

      test(
        'a thread whose only pending work is waiting for the key still gets it',
        { timeout: timeoutForGrants(store, 2) },
        async () => {
          // Arrange: the main thread holds the key, and the worker thread has nothing to do but wait.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const release = Promise.withResolvers<void>();
          const held = mutex.acquire('product:42', () => release.promise);
          const thread = startThread(
            host,
            threadSource(
              store.name,
              fixture.location,
              `await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
            ),
          );
          const events: string[] = [];
          thread.on('message', (event) => {
            if (typeof event === 'string') events.push(event);
          });
          const exited = once(thread, 'exit');

          try {
            // Act: the key stays held long enough for an idle thread to give up.
            await delay(300);
            release.resolve();
            await held;
            const [code] = await exited;

            // Assert: waiting kept the thread alive until the grant arrived.
            assert.deepEqual(
              { code, events },
              { code: 0, events: ['entered'] },
              'The waiting thread must stay alive, get the key, and then exit normally',
            );
          } finally {
            release.resolve();
            await thread.terminate();
          }
        },
      );

      test(
        'messages of its own and unreadable lock messages from a thread leave its locks working',
        { timeout: timeoutForGrants(store, 2) },
        async (t) => {
          // Arrange: the thread posts its own messages to the main thread, and lock envelopes that hold no request.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const thread = startThread(
            host,
            threadSource(
              store.name,
              fixture.location,
              `parentPort.postMessage({ type: 'app' });
						 parentPort.postMessage({ '@lock': 42 });
						 parentPort.postMessage({ '@lock': null });
						 parentPort.postMessage({ '@lock': { op: 'acquire' } });
						 await mutex.acquire('product:42', async () => {});
						 parentPort.postMessage('released');`,
            ),
          );
          const events: string[] = [];
          thread.on('message', (event) => {
            if (typeof event === 'string') events.push(event);
          });

          try {
            // Act
            await t.waitFor(
              () =>
                assert.ok(
                  events.includes('released'),
                  'The thread must take and release the key after its other messages',
                ),
              { interval: 5, timeout: newProcessTimeout },
            );
            // A key that is never handed over keeps this await open until the test times out.
            const next = await mutex.acquire(
              'product:42',
              async () => 'granted' as const,
            );

            // Assert
            assert.equal(
              next,
              'granted',
              'The main thread must get the key the thread released',
            );
          } finally {
            await thread.terminate();
          }
        },
      );

      test(
        'a thread that waits for a key ignores a lock message from the main thread that is not a valid answer',
        { timeout: timeoutForGrants(store, 2) },
        async (t) => {
          // Arrange: the main thread holds the key, and the thread asks for it.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const finishMain = Promise.withResolvers<void>();
          const held = mutex.acquire('product:42', () => finishMain.promise);
          const thread = startThread(
            host,
            threadSource(
              store.name,
              fixture.location,
              `await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
            ),
          );
          const events: string[] = [];
          let request: string | undefined;
          thread.on('message', (event: unknown) => {
            if (typeof event === 'string') events.push(event);
            const message = isRecord(event) ? event['@lock'] : undefined;
            if (isRecord(message) && typeof message.id === 'string')
              request = message.id;
          });

          try {
            await t.waitFor(
              () =>
                assert.ok(
                  request !== undefined,
                  'The thread must ask for the key',
                ),
              { interval: 5, timeout: newProcessTimeout },
            );

            // Act: a grant for the thread's request, with a token that no coordinator issues.
            thread.postMessage({
              '@lock': { op: 'granted', id: request, token: 'not-a-token' },
            });
            await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
            const enteredBeforeRelease = events.includes('entered');
            finishMain.resolve();
            await held;

            // Assert
            assert.equal(
              enteredBeforeRelease,
              false,
              'The thread entered on a grant that was not valid',
            );
            await t.waitFor(
              () =>
                assert.ok(
                  events.includes('entered'),
                  'The thread must enter once the main thread releases',
                ),
              {
                interval: 5,
                timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
              },
            );
          } finally {
            finishMain.resolve();
            await thread.terminate();
          }
        },
      );

      test(
        'four threads incrementing a shared counter never overlap or lose an update',
        { timeout: timeoutForGrants(store, 80) },
        async () => {
          // Arrange
          await using fixture = await store.fixture(process.env);

          // Act
          const result = await incrementFromFourThreads(
            store,
            fixture.location,
          );

          // Assert: one holder at a time, so every increment survives.
          assert.deepEqual(
            result,
            { counter: 80, overlaps: 0 },
            'Two threads held the key at the same time',
          );
        },
      );
    }),
);

void describe.each(
  storeCases.filter((candidate) => reaches(candidate, 'host')),
  (store) =>
    describe(`Threads sharing ${store.name}`, () => {
      test(
        'four threads incrementing a shared counter never overlap or lose an update',
        // Four threads make 20 grants each.
        { timeout: timeoutForGrants(store, 80) },
        async () => {
          // Arrange
          await using fixture = await store.fixture(process.env);

          // Act: each thread builds its own store over the same fixture.
          const result = await incrementFromFourThreads(
            store,
            fixture.location,
          );

          // Assert
          assert.deepEqual(
            result,
            { counter: 80, overlaps: 0 },
            'Two threads held the key at the same time',
          );
        },
      );

      test(
        'the key of a worker thread that was terminated goes to the next waiter',
        { timeout: timeoutForGrants(store, 2) },
        async () => {
          // Arrange: this thread asks first, so a SocketStore leads from here and
          // terminating the holder never ends the leader's term.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          await mutex.acquire('warm-up', async () => {});
          const thread = startThread(
            host,
            threadSource(
              store.name,
              fixture.location,
              `
						setInterval(() => {}, 1000);
						await mutex.acquire('product:42', async () => {
							parentPort.postMessage('holding');
							await new Promise(() => {});
						});
					`,
            ),
          );
          await once(thread, 'message');
          const whileHeld = await mutex.acquire(
            'product:42',
            async (lease) => lease.token,
            { mode: Modes.skipIfBusy() },
          );
          assert.equal(
            whileHeld.acquired,
            false,
            'The thread must hold the key when it is terminated',
          );

          // Act: the thread stops for good while it holds the key.
          await thread.terminate();
          const next = await mutex.acquire(
            'product:42',
            async (lease) => lease.token,
            { mode: Modes.skipIfBusy({ waitAtMost: 2000 }) },
          );

          // Assert: a terminated thread can never release, so nothing should keep its key.
          assert.equal(
            next.acquired,
            true,
            'The key is still held by a thread that no longer exists',
          );
        },
      );
    }),
);
