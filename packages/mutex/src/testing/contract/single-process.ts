import assert from 'node:assert/strict';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';

import { Hono } from 'hono';

import type { FencingToken } from '@zukhruf/fencing';
import { describe, test } from '@zukhruf/testing/node';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { newProcessTimeout } from '../new-process-timeout.ts';
import { settle } from '../timing.ts';
import { startWorker } from '../worker-process.ts';
import { deadlineFor } from './deadlines.ts';
import { label, longKey } from './keys.ts';
import { storeIn } from './peers.ts';
import type { Host, Subject } from './subject.ts';

const mutexUrl = new URL('../../mutex/mutex.ts', import.meta.url);

/** Every lock store: one process, one Mutex. */
export function singleProcess<H extends Host>(store: Subject<H>): void {
  describe(`Single-process mutex with ${store.name}`, () => {
    test('a failed operation rejects its caller and then allows a waiting operation to run', async (t) => {
      // Arrange: the first operation holds the product until it encounters a storage failure.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const failure = new Error('Storage unavailable');
      const failFirst = Promise.withResolvers<void>();
      const events: string[] = [];
      const operations: Array<Promise<boolean>> = [];

      try {
        // Act: another operation for the same key queues while the first is active, then the first fails.
        operations.push(
          mutex.acquire('product:42', async () => {
            events.push('first started');
            await failFirst.promise;
            await nextTurn();
            events.push('first failed');
            throw failure;
          }),
        );
        await t.waitFor(
          () =>
            assert.ok(
              events.includes('first started'),
              'The first operation must start when its product has no active operation',
            ),
          {
            interval: 5,
            timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
          },
        );
        operations.push(
          mutex.acquire('product:42', async () => {
            events.push('second started');
            return true;
          }),
        );
        await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
        failFirst.resolve();

        // Assert: the error reaches its caller, and the waiter runs after failure.
        assert.deepEqual(
          await Promise.allSettled(operations),
          [
            { status: 'rejected', reason: failure },
            { status: 'fulfilled', value: true },
          ],
          'The failed operation must reject with its original error, and the waiting operation must resolve true',
        );
        assert.deepEqual(
          events,
          ['first started', 'first failed', 'second started'],
          'The waiting operation must start only after the first operation fails',
        );
      } finally {
        failFirst.resolve();
        await Promise.allSettled(operations);
      }
    });

    test('handling a failed operation without a waiter keeps the application alive', async (t) => {
      // Arrange: isolate process-level rejection handling from the test runner.
      // All mutex operations still happen inside ONE process and ONE Mutex instance.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);

      // Act: the application catches a failure, then processes another request later.
      await using application = startWorker(
        `
					import assert from 'node:assert/strict';
					import { setImmediate as nextTurn } from 'node:timers/promises';
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};

					const mutex = new Mutex(${storeIn(store.process.module, fixture.location)});
					const failure = new Error('Storage unavailable');

					await assert.rejects(
						mutex.acquire('product:42', async () => {
							await nextTurn();
							throw failure;
						}),
						(error) => error === failure,
						'The caller must receive the original error from its failed operation',
					);

					// Nobody joins the queue until after rejection handling has run.
					await nextTurn();
					assert.equal(
						await mutex.acquire('product:42', async () => true),
						true,
						'A later request must succeed after an earlier caller handled its own failure',
					);
				`,
        'application',
        {
          admit: (child) => store.process.admit(host, child),
          nodeOptions: ['--unhandled-rejections=strict'],
        },
      );
      await t.waitFor(
        () =>
          assert.ok(
            application.exit !== null,
            `The application must finish.\n${application.stderr}`,
          ),
        { interval: 5, timeout: newProcessTimeout },
      );

      // Assert: catching a callback error must be enough to keep the app running.
      assert.deepEqual(
        application.exit,
        { code: 0, signal: null },
        `The application must survive a handled failure and finish the later request.\n${application.stderr}`,
      );
    });

    test('requests for the same product wait until the current operation finishes', async (t) => {
      // Arrange: hold the first operation open until the test releases it.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const finishFirst = Promise.withResolvers<void>();
      let firstStarted = false;
      let secondStarted = false;
      const operations: Array<Promise<boolean>> = [];

      try {
        // Act: submit a second operation for the resource while the first is active.
        operations.push(
          mutex.acquire('product:42', async () => {
            firstStarted = true;
            await finishFirst.promise;
            return true;
          }),
        );
        await t.waitFor(
          () =>
            assert.ok(
              firstStarted,
              'The first operation must start when its product has no active operation',
            ),
          {
            interval: 5,
            timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
          },
        );
        operations.push(
          mutex.acquire('product:42', async () => {
            secondStarted = true;
            return false;
          }),
        );
        await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));

        // Assert: the second callback has not entered while the first is open.
        assert.equal(
          secondStarted,
          false,
          'The second operation entered before the first finished',
        );

        finishFirst.resolve();
        assert.deepEqual(
          await Promise.allSettled(operations),
          [
            { status: 'fulfilled', value: true },
            { status: 'fulfilled', value: false },
          ],
          'Both operations must finish and return their own results: true for the first, false for the second',
        );
        assert.equal(
          secondStarted,
          true,
          'The waiting operation must run after the first operation finishes',
        );
      } finally {
        finishFirst.resolve();
        await Promise.allSettled(operations);
      }
    });

    test('three overlapping requests for one product all finish without overlapping callbacks', async (t) => {
      // Arrange: whichever callback enters first stays active while the other requests queue.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const finishFirst = Promise.withResolvers<void>();
      let entered = 0;
      let active = 0;
      let peakActive = 0;
      const completed: number[] = [];

      // Act: submit the entire burst before letting the first callback finish.
      const outcomes = Promise.allSettled(
        [true, false, true].map((result, index) => {
          return mutex.acquire('product:42', async () => {
            const isFirstToEnter = entered++ === 0;
            active++;
            peakActive = Math.max(peakActive, active);
            try {
              if (isFirstToEnter) await finishFirst.promise;
              await nextTurn();
              completed.push(index);
              return result;
            } finally {
              active--;
            }
          });
        }),
      );

      try {
        await t.waitFor(
          () =>
            assert.ok(
              entered === 1,
              'One request must enter while the burst is submitted',
            ),
          {
            interval: 5,
            timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
          },
        );
        await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
        finishFirst.resolve();
        // A request that is never granted keeps this await open until the test times out.
        const results = await outcomes;

        // Assert: exclusion must also allow every waiting request to make progress.
        assert.deepEqual(
          results,
          [
            { status: 'fulfilled', value: true },
            { status: 'fulfilled', value: false },
            { status: 'fulfilled', value: true },
          ],
          'Each request in the burst must receive its own callback result',
        );
        assert.equal(
          peakActive,
          1,
          'Callbacks for the same product must never be active at the same time',
        );
        assert.deepEqual(
          completed.sort((a, b) => a - b),
          [0, 1, 2],
          'Every submitted operation must perform its work exactly once',
        );
      } finally {
        finishFirst.resolve();
        // Do not await outcomes: a deadlocked mutex would hang here instead of failing.
      }
    });

    test('a blocked product does not prevent another product from being processed', async (t) => {
      // Arrange: keep product 42 busy before product 99 is requested.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const finishFirst = Promise.withResolvers<void>();
      let firstStarted = false;
      let secondFinished = false;
      const operations: Array<Promise<boolean>> = [];

      try {
        operations.push(
          mutex.acquire('product:42', async () => {
            firstStarted = true;
            await finishFirst.promise;
            return true;
          }),
        );
        await t.waitFor(
          () =>
            assert.ok(
              firstStarted,
              'Product 42 must be held before product 99 is requested',
            ),
          {
            interval: 5,
            timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
          },
        );

        // Act: this operation uses a different resource key.
        operations.push(
          mutex.acquire('product:99', async () => {
            secondFinished = true;
            return true;
          }),
        );

        // Assert: product 99 progressed before product 42 was released.
        await t.waitFor(
          () => assert.ok(secondFinished, 'An unrelated product was blocked'),
          {
            interval: 5,
            timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
          },
        );
        finishFirst.resolve();
        assert.deepEqual(
          await Promise.allSettled(operations),
          [
            { status: 'fulfilled', value: true },
            { status: 'fulfilled', value: true },
          ],
          'Operations for both independent products must finish successfully once the held operation is released',
        );
      } finally {
        finishFirst.resolve();
        await Promise.allSettled(operations);
      }
    });

    test('an out-of-stock result does not prevent a later reservation for the same product', async () => {
      // Arrange: initially there is nothing to reserve.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      let stock = 0;

      // Act: one request is declined, then stock arrives before the next request.
      const outcomes = Promise.allSettled([
        (async () => {
          const soldOut = await mutex.acquire('product:42', async () => {
            await nextTurn();
            return stock > 0;
          });

          stock = 1;
          const restocked = await mutex.acquire('product:42', async () => {
            await nextTurn();
            if (stock === 0) return false;
            stock--;
            return true;
          });
          return { soldOut, restocked };
        })(),
      ]);

      // A later request that is never granted keeps this await open until the test times out.
      const results = await outcomes;

      // Assert: false is a normal result, and the resource remains usable later.
      assert.deepEqual(
        results,
        [{ status: 'fulfilled', value: { soldOut: false, restocked: true } }],
        'The first caller must receive false and the later caller must receive its fresh true result',
      );
      assert.equal(
        stock,
        0,
        'The later callback must actually reserve the newly available item exactly once',
      );
    });

    void test.each(
      ['constructor', '__proto__', longKey, 'مخزن'.repeat(75), 'report-\uD800'],
      (key) =>
        test(`resource name ${label(key)} supports ordinary mutex operations`, async (t) => {
          // Arrange: resource names may come directly from user-supplied names or slugs.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const finishFirst = Promise.withResolvers<void>();
          let firstStarted = false;
          let secondStarted = false;
          const operations: Array<Promise<boolean>> = [];

          try {
            // Act: two callers use exactly the same resource name.
            operations.push(
              mutex.acquire(key, async () => {
                firstStarted = true;
                await finishFirst.promise;
                return true;
              }),
            );
            await t.waitFor(
              () =>
                assert.ok(
                  firstStarted,
                  `The first operation for ${label(key)} must start`,
                ),
              {
                interval: 5,
                timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
              },
            );
            operations.push(
              mutex.acquire(key, async () => {
                secondStarted = true;
                return false;
              }),
            );
            await delay(deadlineFor(store, settle, { grants: 1, releases: 0 }));
            assert.equal(
              secondStarted,
              false,
              `The second operation for ${label(key)} must wait for the first`,
            );
            finishFirst.resolve();
            // A second operation that is never granted keeps this await open until the test times out.
            const results = await Promise.allSettled(operations);

            // Assert: these strings are valid resource names, just like product:42.
            assert.deepEqual(
              results,
              [
                { status: 'fulfilled', value: true },
                { status: 'fulfilled', value: false },
              ],
              `Resource name ${label(key)} must work and preserve both callers' results`,
            );
          } finally {
            finishFirst.resolve();
          }
        }),
    );

    void test.each(
      [
        [`${longKey.slice(1)}1`, `${longKey.slice(1)}2`],
        ['report-\uD800', 'report-\uD801'],
        ['report-\uD800', 'report-�'],
      ] as const,
      ([held, other]) =>
        test(`resource names ${label(held)} and ${label(other)} are separate locks`, async (t) => {
          // Arrange: one caller holds the first name.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const finishHolder = Promise.withResolvers<void>();
          let holding = false;
          const holder = mutex.acquire(held, async () => {
            holding = true;
            await finishHolder.promise;
          });

          try {
            await t.waitFor(
              () =>
                assert.ok(holding, `The holder of ${label(held)} must start`),
              {
                interval: 5,
                timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
              },
            );

            // Act: another caller asks for the second name and does not wait.
            const result = await mutex.acquire(other, async () => 'ran', {
              mode: Modes.skipIfBusy(),
            });

            // Assert: names that differ only near their end, or only in a lone surrogate, do not share a lock.
            assert.deepEqual(
              result,
              { acquired: true, value: 'ran' },
              `${label(other)} must be free while ${label(held)} is held`,
            );
          } finally {
            finishHolder.resolve();
            await holder;
          }
        }),
    );

    // On a case-sensitive file system (Linux) this passes whatever the stores
    // name their files; macOS and Windows fold case and so show the break.
    test('resource names that differ only in letter case are separate locks', async (t) => {
      // Arrange: one caller holds 'Sync'.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const finishHolder = Promise.withResolvers<void>();
      let holding = false;
      const holder = mutex.acquire('Sync', async () => {
        holding = true;
        await finishHolder.promise;
      });

      try {
        await t.waitFor(
          () => assert.ok(holding, "The holder of 'Sync' must start"),
          {
            interval: 5,
            timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
          },
        );

        // Act: other callers ask for 'sync' and 'SYNC' and do not wait.
        const lower = await mutex.acquire('sync', async () => 'ran', {
          mode: Modes.skipIfBusy(),
        });
        const upper = await mutex.acquire('SYNC', async () => 'ran', {
          mode: Modes.skipIfBusy(),
        });

        // Assert
        assert.deepEqual(
          { lower, upper },
          {
            lower: { acquired: true, value: 'ran' },
            upper: { acquired: true, value: 'ran' },
          },
          "'sync' and 'SYNC' must be free while 'Sync' is held",
        );
      } finally {
        finishHolder.resolve();
        await holder;
      }
    });

    test('two HTTP reservations cannot both buy the last item across an async storage step', async () => {
      // Arrange: this app and its inventory belong only to this test.
      await using fixture = await store.fixture(process.env);
      const app = new Hono();
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      let stock = 1;

      app.post('/reserve', async (c) => {
        const reserved = await mutex.acquire('product:42', async () => {
          const currentStock = stock;
          if (currentStock === 0) return false;

          // Simulate asynchronous storage between reading and saving stock.
          await nextTurn();
          stock = currentStock - 1;
          return true;
        });
        return c.json({ reserved }, reserved ? 201 : 409);
      });

      // Act: both requests start before either response is awaited.
      const requests = [
        app.request('/reserve', { method: 'POST' }),
        app.request('/reserve', { method: 'POST' }),
      ];

      try {
        const responses = await Promise.all(requests);

        // Assert: exactly one request succeeds, regardless of which one wins.
        assert.deepEqual(
          responses.map((response) => response.status).sort(),
          [201, 409],
          'With one item available, exactly one request must succeed with 201 and the other must return 409',
        );
        const bodies: any[] = await Promise.all(
          responses.map((response) => response.json()),
        );
        assert.equal(
          bodies.filter((body) => body.reserved === true).length,
          1,
          'Exactly one response body must confirm a successful reservation',
        );
        assert.equal(
          bodies.filter((body) => body.reserved === false).length,
          1,
          'Exactly one response body must report that no item was reserved',
        );
        assert.equal(
          stock,
          0,
          'After one successful reservation, the remaining stock must be zero',
        );
      } finally {
        await Promise.allSettled(requests);
      }
    });

    test('concurrent requests receive fencing tokens that grow in the order the lock was granted', async () => {
      // Arrange: a burst of requests competes for one key.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const grantedTokens: FencingToken[] = [];

      // Act: each holder records its token at the moment it holds the lock.
      await Promise.all(
        Array.from({ length: 5 }, () =>
          mutex.acquire('product:42', async (lease) => {
            grantedTokens.push(lease.token);
            await nextTurn();
          }),
        ),
      );

      // Assert: a later holder always carries a newer token than an earlier one.
      assert.equal(grantedTokens.length, 5, 'Every request must be granted');
      assert.ok(
        grantedTokens.every(
          (token, index) =>
            index === 0 || token.isNewerThan(grantedTokens[index - 1]!),
        ),
        `Tokens must strictly increase in grant order, got ${grantedTokens.join(', ')}`,
      );
    });
  });
}
