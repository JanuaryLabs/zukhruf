import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { describe, test } from '@zukhruf/parameterized-test';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { startThread, threadSource } from './peers.ts';
import type { Host, SharedByThreads, Subject } from './subject.ts';

/**
 * The rounds of each thread: 20, or as many as about 2 s of grants at the
 * store's usual grant time and never fewer than 6, so a store whose grant is
 * slow still hands the key over 24 times. A copy of the rounds of the
 * processes contract (docs/copied-code.md).
 */
const roundsOf = (store: Pick<Subject, 'grantLatency'>): number =>
  Math.min(20, Math.max(6, Math.round(2_000 / store.grantLatency)));

/**
 * Four threads, this one and three workers, each add 1 to a shared counter
 * `roundsOf` times, reading and writing around an `await`, under the key.
 * Each first takes another key once, so its store is connected, and
 * they start their rounds together: with no exclusion, their first rounds
 * overlap, however few rounds there are.
 */
async function incrementFromFourThreads<H extends Host>(
  store: Subject<H>,
  sharing: SharedByThreads<H>,
  location: string,
) {
  await using host = store.open(location);
  const mutex = new Mutex(host.store);
  const rounds = roundsOf(store);
  // [counter, holders inside the critical section, overlaps seen, threads ready, go]
  const shared = new Int32Array(new SharedArrayBuffer(20));
  const increment = async () => {
    if (Atomics.add(shared, 1, 1) !== 0) Atomics.add(shared, 2, 1);
    const value = shared[0]!;
    await nextTurn();
    shared[0] = value + 1;
    Atomics.sub(shared, 1, 1);
  };
  const body = `
		const shared = workerData;
		await mutex.acquire('warm-up', async () => {});
		Atomics.add(shared, 3, 1);
		Atomics.notify(shared, 3);
		// Atomics.waitAsync holds no ref on the event loop, so a timer keeps the
		// thread alive while it waits for the go.
		const keep = setInterval(() => {}, 1_000);
		await Atomics.waitAsync(shared, 4, 0).value;
		clearInterval(keep);
		for (let i = 0; i < ${rounds}; i++) {
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
      startThread(
        sharing,
        host,
        threadSource(sharing.module, location, body),
        shared,
      ),
      'exit',
    ),
  );
  await mutex.acquire('warm-up', async () => {});
  for (
    let ready = Atomics.load(shared, 3);
    ready < 3;
    ready = Atomics.load(shared, 3)
  )
    await Atomics.waitAsync(shared, 3, ready).value;
  Atomics.store(shared, 4, 1);
  Atomics.notify(shared, 4);
  for (let i = 0; i < rounds; i++) await mutex.acquire('counter', increment);
  const codes = (await Promise.all(exits)).map(([code]: unknown[]) => code);
  return {
    counter: shared[0],
    overlaps: shared[2],
    expected: 4 * rounds,
    codes,
  };
}

/** A store whose worker threads share its locks. */
export function threads<H extends Host>(
  store: Subject<H>,
  sharing: SharedByThreads<H>,
): void {
  describe(`Holder check from a worker thread with ${store.name}`, () => {
    test('looks from another thread never make a caller that skips if busy give up on a free key', async () => {
      // Arrange: a worker thread starts one look each time it is asked, and tells when the look is in flight and when it is done.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      // [stop, looks done, looks asked for, looks started]
      const shared = new Int32Array(new SharedArrayBuffer(16));
      const looker = startThread(
        sharing,
        host,
        threadSource(
          sharing.module,
          fixture.location,
          `
						const shared = workerData;
						// A pending Atomics.waitAsync does not keep a thread alive.
						setInterval(() => {}, 1000);
						let asked = 0;
						while (Atomics.load(shared, 0) === 0) {
							await Atomics.waitAsync(shared, 2, asked).value;
							asked = Atomics.load(shared, 2);
							// Start the look before the signal: its request then reaches the coordinator before the attempt does.
							const look = mutex.isHeld('report:daily');
							Atomics.store(shared, 3, asked);
							Atomics.notify(shared, 3);
							await look;
							Atomics.add(shared, 1, 1);
							Atomics.notify(shared, 1);
						}
					`,
        ),
        shared,
      );
      try {
        // Act: before each attempt on the free key, one look from the worker thread is in flight.
        const results = [];
        for (let attempt = 0; attempt < 50; attempt++) {
          Atomics.store(shared, 2, attempt + 1);
          Atomics.notify(shared, 2);
          await Atomics.waitAsync(shared, 3, attempt).value;
          results.push(
            await mutex.acquire('report:daily', async () => 'ran', {
              mode: Modes.skipIfBusy(),
            }),
          );
          await Atomics.waitAsync(shared, 1, attempt).value;
        }

        // Assert
        assert.equal(
          Atomics.load(shared, 1),
          50,
          'The worker thread must make one look during each attempt',
        );
        assert.deepEqual(
          results.filter((result) => !result.acquired),
          [],
          'A look must never make a free key busy',
        );
      } finally {
        Atomics.store(shared, 0, 1);
        await looker.terminate();
      }
    });
  });
  describe(`Threads sharing ${store.name}`, () => {
    test('four threads incrementing a shared counter never overlap or lose an update', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);

      // Act: each thread builds its own store over the same fixture.
      const result = await incrementFromFourThreads(
        store,
        sharing,
        fixture.location,
      );

      // Assert
      assert.deepEqual(
        result,
        {
          counter: result.expected,
          overlaps: 0,
          expected: result.expected,
          codes: [0, 0, 0],
        },
        'Two threads held the key at the same time',
      );
    });

    test('the key of a worker thread that was terminated goes to the next waiter', async (t) => {
      // Arrange: this thread asks first, so a SocketStore leads from here and
      // terminating the holder never ends the leader's term.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      await mutex.acquire('warm-up', async () => {});
      const thread = startThread(
        sharing,
        host,
        threadSource(
          sharing.module,
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
      // A thread of a store over its port sends its lock messages on the same channel, so the test waits for its own message.
      const holding = Promise.withResolvers<void>();
      thread.on('message', (message) => {
        if (message === 'holding') holding.resolve();
      });
      await untilAborted(holding.promise, t.signal);
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

      // Assert: a terminated thread can never release, so nothing should keep its key.
      assert.equal(
        await mutex.acquire('product:42', async () => 'granted', {
          signal: t.signal,
        }),
        'granted',
        'The key is still held by a thread that no longer exists',
      );
    });
  });
}
