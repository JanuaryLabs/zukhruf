import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { Hono } from 'hono';

import {
  CounterTokenSource,
  type FencingToken,
  type TokenSource,
} from '@zukhruf/fencing';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { describe, test } from '@zukhruf/testing/node';

import { IpcLockCoordinator } from '../lock-stores/ipc/index.ts';
import { ThreadLockCoordinator } from '../lock-stores/thread/index.ts';
import { isRecord } from '../shared/is-record.ts';
import { newProcessTimeout } from '../testing/new-process-timeout.ts';
import {
  deadlineFor,
  settle,
  storeCases,
  timeoutForGrants,
} from '../testing/store-cases.ts';
import { startWorker } from '../testing/worker-process.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

const mutexUrl = new URL('./mutex.ts', import.meta.url);
const storeCasesUrl = new URL('../testing/store-cases.ts', import.meta.url);

/** Longer than any file name, so a lock store that names a file after the key cannot use the key as it is. */
const longKey = 'k'.repeat(1000);

/** Names a key in a test title without printing all of a long key. */
const label = (key: string) =>
  key.length > 32
    ? `${JSON.stringify(`…${key.slice(-4)}`)} of ${key.length} characters`
    : JSON.stringify(key);

void describe.each(storeCases, (store) =>
  describe(`Single-process mutex with ${store.name}`, () => {
    test(
      'a failed operation rejects its caller and then allows a waiting operation to run',
      { timeout: timeoutForGrants(store, 2) },
      async (t) => {
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
      },
    );

    test(
      'handling a failed operation without a waiter keeps the application alive',
      { timeout: timeoutForGrants(store, 2) },
      async (t) => {
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
					import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};

					const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(fixture.location)}));
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
          { host, nodeOptions: ['--unhandled-rejections=strict'] },
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
      },
    );

    test(
      'requests for the same product wait until the current operation finishes',
      { timeout: timeoutForGrants(store, 2) },
      async (t) => {
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
      },
    );

    test(
      'three overlapping requests for one product all finish without overlapping callbacks',
      { timeout: timeoutForGrants(store, 3) },
      async (t) => {
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
      },
    );

    test(
      'a blocked product does not prevent another product from being processed',
      { timeout: timeoutForGrants(store, 2) },
      async (t) => {
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
      },
    );

    test(
      'an out-of-stock result does not prevent a later reservation for the same product',
      { timeout: timeoutForGrants(store, 2) },
      async () => {
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
      },
    );

    void test.each(
      ['constructor', '__proto__', longKey, 'مخزن'.repeat(75), 'report-\uD800'],
      (key) =>
        test(
          `resource name ${label(key)} supports ordinary mutex operations`,
          { timeout: timeoutForGrants(store, 2) },
          async (t) => {
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
              await delay(
                deadlineFor(store, settle, { grants: 1, releases: 0 }),
              );
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
          },
        ),
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

    test(
      'two HTTP reservations cannot both buy the last item across an async storage step',
      { timeout: timeoutForGrants(store, 2) },
      async () => {
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
      },
    );

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

    void test.each(['product:42', longKey], (key) =>
      test(
        `a new store over the same fixture keeps issuing newer tokens for resource name ${label(key)}`,
        {
          skip: store.durableTokens
            ? false
            : 'this store keeps its token counter in memory by design',
        },
        async () => {
          // Arrange: one store instance holds the key once, then goes away (e.g. a restart).
          await using fixture = await store.fixture(process.env);
          let before: FencingToken;
          {
            await using previous = store.open(fixture.location);
            before = await new Mutex(previous.store).acquire(
              key,
              async (lease) => lease.token,
            );
          }

          // Act: a fresh instance over the same fixture holds the key again.
          await using restarted = store.open(fixture.location);
          const after = await new Mutex(restarted.store).acquire(
            key,
            async (lease) => lease.token,
          );

          // Assert: the restart did not reset the token sequence.
          assert.ok(
            after.isNewerThan(before),
            `The token after a restart (${after}) must be newer than before it (${before})`,
          );
        },
      ),
    );
  }),
);

describe('Process-tree mutex with IpcStore', () => {
  test(
    'messages of its own and unreadable lock messages from a child leave its locks working',
    { timeout: 15000 },
    async (t) => {
      // Arrange: the child sends its parent its own messages, and lock envelopes that hold no request.
      const coordinator = new IpcLockCoordinator();
      const mutex = new Mutex(coordinator);
      const ipcStoreUrl = new URL(
        '../lock-stores/ipc/ipc-store.ts',
        import.meta.url,
      );
      await using child = startWorker(
        `
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { IpcStore } from ${JSON.stringify(ipcStoreUrl.href)};

					const mutex = new Mutex(new IpcStore());
					process.send({ type: 'app' });
					process.send({ '@lock': 42 });
					process.send({ '@lock': null });
					process.send({ '@lock': { op: 'acquire' } });
					await mutex.acquire('product:42', async () => {});
					process.send({ type: 'released' });
				`,
        'child',
        { host: { adoptProcess: (process) => coordinator.adopt(process) } },
      );

      // Act
      await t.waitFor(
        () =>
          assert.ok(
            child.has('released'),
            `The child must take and release the key after its other messages.\n${child.stderr}`,
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
        'The parent must get the key the child released',
      );
    },
  );

  test(
    'a child waiting for a key learns that no coordinator is left when its parent dies',
    {
      timeout: 10000,
      skip:
        process.platform === 'win32'
          ? 'On Windows, libuv stops the children of a process that stops (job object), so no child is left waiting'
          : false,
    },
    async (t) => {
      // Arrange: a parent holds the key and coordinates a child that waits for it.
      // The child reports through a journal file, because its only channel is to that parent.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const journal = join(directory.path, 'child.log');
      const ipcLockCoordinatorUrl = new URL(
        '../lock-stores/ipc/ipc-lock-coordinator.ts',
        import.meta.url,
      );
      const ipcStoreUrl = new URL(
        '../lock-stores/ipc/ipc-store.ts',
        import.meta.url,
      );
      const childSource = `
				import { appendFileSync } from 'node:fs';
				import { Mutex } from ${JSON.stringify(mutexUrl.href)};
				import { IpcStore } from ${JSON.stringify(ipcStoreUrl.href)};

				const mutex = new Mutex(new IpcStore());
				appendFileSync(${JSON.stringify(journal)}, 'requested\\n');
				try {
					await mutex.acquire('product:42', async () => {
						appendFileSync(${JSON.stringify(journal)}, 'entered\\n');
					});
				} catch (error) {
					appendFileSync(${JSON.stringify(journal)}, 'rejected:' + error.name + '\\n');
				}
			`;
      await using parent = startWorker(
        `
					import { spawn } from 'node:child_process';
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { IpcLockCoordinator } from ${JSON.stringify(ipcLockCoordinatorUrl.href)};

					const coordinator = new IpcLockCoordinator();
					const mutex = new Mutex(coordinator);
					setInterval(() => {}, 1000);
					await mutex.acquire('product:42', async () => {
						const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
						coordinator.adopt(child);
						process.send({ type: 'entered' });
						await new Promise(() => {});
					});
				`,
        'parent',
      );
      const childLog = async () =>
        (await readFile(journal, 'utf8').catch(() => '')).trim().split('\n');
      let log: string[] = [];
      const waitForLog = (line: string, message: string) =>
        t.waitFor(
          async () => {
            log = await childLog();
            assert.ok(log.includes(line), `${message}\n${parent.stderr}`);
          },
          { interval: 10, timeout: 3000 },
        );

      await waitForLog(
        'requested',
        'The child must ask its parent for the key',
      );
      await delay(settle);

      // Act: the parent dies while the child is still waiting.
      parent.child.kill('SIGKILL');
      await parent.closed;

      // Assert: the child is told plainly instead of waiting forever or being granted.
      await t.waitFor(
        async () => {
          log = await childLog();
          assert.ok(log.some((line) => line.startsWith('rejected:')));
        },
        { interval: 10, timeout: 3000 },
      );
      assert.deepEqual(
        log,
        ['requested', 'rejected:CoordinatorUnavailableError'],
        'A waiting child must reject with CoordinatorUnavailableError once its coordinator is gone',
      );
    },
  );

  test(
    'with no coordinator left, a waiting acquire, a try in flight, and every later call reject with CoordinatorUnavailableError',
    {
      timeout: 15_000,
      skip:
        process.platform === 'win32'
          ? 'On Windows, libuv stops the children of a process that stops (job object), and there is no SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a parent holds the key and coordinates a child that waits for it.
      // The child reports through a journal file, because its only channel is to that parent.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const journal = join(directory.path, 'child.log');
      const ipcUrl = new URL('../lock-stores/ipc/index.ts', import.meta.url);
      const childSource = `
				import { appendFileSync } from 'node:fs';
				import { IpcStore } from ${JSON.stringify(ipcUrl.href)};

				const store = new IpcStore();
				const log = (line) => appendFileSync(${JSON.stringify(journal)}, line + '\\n');
				const settled = (name, call) =>
					call.then(() => log(name + ':settled'), (error) => log(name + ':rejected:' + error.name));
				settled('acquire', store.acquire('product:42')).then(() => {
					settled('later acquire', store.acquire('other'));
					settled('later look', store.isHeld('product:42'));
				});
				process.on('SIGUSR2', () => {
					settled('try', store.tryAcquire('free'));
					log('try sent');
				});
				log('waiting');
			`;
      await using parent = startWorker(
        `
					import { spawn } from 'node:child_process';
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { IpcLockCoordinator } from ${JSON.stringify(ipcUrl.href)};

					const coordinator = new IpcLockCoordinator();
					const mutex = new Mutex(coordinator);
					setInterval(() => {}, 1000);
					await mutex.acquire('product:42', async () => {
						const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
						coordinator.adopt(child);
						process.send({ type: 'entered', child: child.pid });
						await new Promise(() => {});
					});
				`,
        'parent',
      );
      let log: string[] = [];
      const waitForLog = (done: (log: string[]) => boolean, message: string) =>
        t.waitFor(
          async () => {
            log = (await readFile(journal, 'utf8').catch(() => ''))
              .trim()
              .split('\n');
            assert.ok(
              done(log),
              `${message}\n${log.join('\n')}\n${parent.stderr}`,
            );
          },
          { interval: 10, timeout: newProcessTimeout },
        );
      await waitForLog(
        (lines) => lines.includes('waiting'),
        'The child must ask its parent for the key',
      );
      const child = parent.find('entered')?.child;
      assert.equal(typeof child, 'number');

      // Act: the parent stops answering, the child sends a try, and then the parent dies.
      parent.child.kill('SIGSTOP');
      process.kill(Number(child), 'SIGUSR2');
      await waitForLog(
        (lines) => lines.includes('try sent'),
        'The child must send its try',
      );
      parent.child.kill('SIGKILL');
      await parent.closed;

      // Assert: every call is told plainly, at once, instead of waiting forever or being granted.
      await waitForLog(
        (lines) => lines.length >= 6,
        'Every call must end once the coordinator is gone',
      );
      assert.deepEqual(log.filter((line) => line.includes(':')).sort(), [
        'acquire:rejected:CoordinatorUnavailableError',
        'later acquire:rejected:CoordinatorUnavailableError',
        'later look:rejected:CoordinatorUnavailableError',
        'try:rejected:CoordinatorUnavailableError',
      ]);
    },
  );
});

/** Counts tokens like CounterTokenSource, but its first mint fails, as a token file on a full disk would. */
function tokensThatFailOnce(): TokenSource {
  const counter = new CounterTokenSource();
  let failed = false;
  return {
    async next(key) {
      if (failed) return counter.next(key);
      failed = true;
      throw new Error('The token file could not be written.');
    },
  };
}

describe('A worker or child whose token cannot be minted', () => {
  test(
    'a worker thread learns that its acquire failed, takes another key, and that key is free once the thread stops',
    { timeout: 15000 },
    async () => {
      // Arrange: the parent's token source fails for the first grant.
      const coordinator = new ThreadLockCoordinator({
        tokens: tokensThatFailOnce(),
      });
      const mutex = new Mutex(coordinator);
      const threadStoreUrl = new URL(
        '../lock-stores/thread/thread-store.ts',
        import.meta.url,
      );
      const thread = new Worker(
        `
          (async () => {
            const { parentPort } = await import('node:worker_threads');
            const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
            const { ThreadStore } = await import(${JSON.stringify(threadStoreUrl.href)});
            const mutex = new Mutex(new ThreadStore());
            const failure = await mutex.acquire('product:42', async () => 'granted').then(
              (result) => result,
              (error) => error.name + ': ' + error.message,
            );
            setInterval(() => {}, 1000);
            await mutex.acquire('product:43', async () => {
              parentPort.postMessage({ type: 'holding', failure });
              await new Promise(() => {});
            });
          })();
        `,
        { eval: true },
      );
      coordinator.adopt(thread);

      try {
        // Act: the thread reports while it holds the second key, and then stops.
        // The port also carries the lock messages, so only the report is read.
        const report = new Promise<unknown>((resolve) => {
          thread.on('message', (message) => {
            if (isRecord(message) && message.type === 'holding')
              resolve(message.failure);
          });
        });
        const failure = await Promise.race([
          report,
          delay(newProcessTimeout, 'the thread never reported', {
            ref: false,
          }),
        ]);
        await thread.terminate();
        const next = await mutex.acquire(
          'product:43',
          async () => 'granted' as const,
          { mode: Modes.skipIfBusy({ waitAtMost: 2000 }) },
        );

        // Assert
        assert.equal(
          failure,
          'GrantFailedError: The lock coordinator could not grant "product:42": The token file could not be written.',
        );
        assert.equal(
          next.acquired,
          true,
          'The key of a thread that stopped must be free',
        );
      } finally {
        await thread.terminate();
      }
    },
  );

  test(
    'a child learns that its try failed, takes another key, and that key is free once the child exits',
    { timeout: 15000 },
    async (t) => {
      // Arrange: the parent's token source fails for the first grant.
      const coordinator = new IpcLockCoordinator({
        tokens: tokensThatFailOnce(),
      });
      const mutex = new Mutex(coordinator);
      const ipcStoreUrl = new URL(
        '../lock-stores/ipc/ipc-store.ts',
        import.meta.url,
      );
      const modesUrl = new URL('./acquire-modes/modes.ts', import.meta.url);
      await using child = startWorker(
        `
          import { Mutex } from ${JSON.stringify(mutexUrl.href)};
          import { Modes } from ${JSON.stringify(modesUrl.href)};
          import { IpcStore } from ${JSON.stringify(ipcStoreUrl.href)};

          const mutex = new Mutex(new IpcStore());
          const failure = await mutex
            .acquire('product:42', async () => 'granted', { mode: Modes.skipIfBusy() })
            .then(
              (result) => JSON.stringify(result),
              (error) => error.name + ': ' + error.message,
            );
          setInterval(() => {}, 1000);
          await mutex.acquire('product:43', async () => {
            process.send({ type: 'holding', failure });
            await new Promise(() => {});
          });
        `,
        'child',
        { host: { adoptProcess: (process) => coordinator.adopt(process) } },
      );

      // Act: the child reports while it holds the second key, and then exits.
      await t.waitFor(
        () =>
          assert.ok(
            child.has('holding'),
            `The child must report while it holds a key.\n${child.stderr}`,
          ),
        { interval: 5, timeout: newProcessTimeout },
      );
      child.child.kill('SIGKILL');
      await child.closed;
      const next = await mutex.acquire(
        'product:43',
        async () => 'granted' as const,
        { mode: Modes.skipIfBusy({ waitAtMost: 2000 }) },
      );

      // Assert
      assert.equal(
        child.find('holding')?.failure,
        'GrantFailedError: The lock coordinator could not grant "product:42": The token file could not be written.',
      );
      assert.equal(
        next.acquired,
        true,
        'The key of a child that exited must be free',
      );
    },
  );
});
