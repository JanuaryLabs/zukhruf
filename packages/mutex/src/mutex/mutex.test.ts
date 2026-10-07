import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { Hono } from 'hono';

import type { FencingToken } from '../fencing/fencing-token.ts';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import {
  type StoreCase,
  type StoreHost,
  settle,
  storeCases,
} from '../testing/store-cases.ts';
import { waitUntil } from '../testing/wait-until.ts';
import { watch } from '../testing/watch.ts';
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

for (const store of storeCases) {
  describe(`Single-process mutex with ${store.name}`, () => {
    test(
      'a failed operation rejects its caller and then allows a waiting operation to run',
      { timeout: 2000 },
      async (t) => {
        // Arrange: the first operation holds the product until it encounters a storage failure.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
          await waitUntil(
            t,
            () => events.includes('first started'),
            'The first operation must start when its product has no active operation',
          );
          operations.push(
            mutex.acquire('product:42', async () => {
              events.push('second started');
              return true;
            }),
          );
          await delay(settle);
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
      { timeout: 15000 },
      async (t) => {
        // Arrange: isolate process-level rejection handling from the test runner.
        // All mutex operations still happen inside ONE process and ONE Mutex instance.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);

        // Act: the application catches a failure, then processes another request later.
        await using application = startWorker(
          `
					import assert from 'node:assert/strict';
					import { setImmediate as nextTurn } from 'node:timers/promises';
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};

					const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory.path)}));
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
        // A new Node process loads the TypeScript sources first: about 170 ms
        // on a calm machine, and more than 2 s on a CI runner that also runs
        // the Docker tests.
        await waitUntil(
          t,
          () => application.exit !== null,
          `The application must finish within ten seconds.\n${application.stderr}`,
          10_000,
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
      { timeout: 2000 },
      async (t) => {
        // Arrange: hold the first operation open until the test releases it.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
          await waitUntil(
            t,
            () => firstStarted,
            'The first operation must start when its product has no active operation',
          );
          operations.push(
            mutex.acquire('product:42', async () => {
              secondStarted = true;
              return false;
            }),
          );
          await delay(settle);

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

    test('three overlapping requests for one product all finish without overlapping callbacks', async (t) => {
      // Arrange: whichever callback enters first stays active while the other requests queue.
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
      const mutex = new Mutex(host.store);
      const finishFirst = Promise.withResolvers<void>();
      const deadline = Promise.withResolvers<null>();
      const timer = setTimeout(() => deadline.resolve(null), 2000);
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
        await waitUntil(
          t,
          () => entered === 1,
          'One request must enter while the burst is submitted',
        );
        await delay(settle);
        finishFirst.resolve();
        const results = await Promise.race([outcomes, deadline.promise]);

        // Assert: exclusion must also allow every waiting request to make progress.
        assert.notEqual(
          results,
          null,
          'All three requests must finish within two seconds after the held callback is released',
        );
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
        clearTimeout(timer);
        // Do not await outcomes: a deadlocked mutex would hang here instead of failing.
      }
    });

    test(
      'a blocked product does not prevent another product from being processed',
      { timeout: 2000 },
      async (t) => {
        // Arrange: keep product 42 busy before product 99 is requested.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
          await waitUntil(
            t,
            () => firstStarted,
            'Product 42 must be held before product 99 is requested',
          );

          // Act: this operation uses a different resource key.
          operations.push(
            mutex.acquire('product:99', async () => {
              secondFinished = true;
              return true;
            }),
          );

          // Assert: product 99 progressed before product 42 was released.
          await waitUntil(
            t,
            () => secondFinished,
            'An unrelated product was blocked',
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

    test('an out-of-stock result does not prevent a later reservation for the same product', async () => {
      // Arrange: initially there is nothing to reserve.
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
      const mutex = new Mutex(host.store);
      let stock = 0;
      const deadline = Promise.withResolvers<null>();
      const timer = setTimeout(() => deadline.resolve(null), 1000);

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

      try {
        const results = await Promise.race([outcomes, deadline.promise]);

        // Assert: false is a normal result, and the resource remains usable later.
        assert.notEqual(
          results,
          null,
          'A later request must finish within one second even when the previous callback returned false',
        );
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
      } finally {
        clearTimeout(timer);
      }
    });

    for (const key of [
      'constructor',
      '__proto__',
      longKey,
      'مخزن'.repeat(75),
      'report-\uD800',
    ]) {
      test(`resource name ${label(key)} supports ordinary mutex operations`, async (t) => {
        // Arrange: resource names may come directly from user-supplied names or slugs.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const finishFirst = Promise.withResolvers<void>();
        const deadline = Promise.withResolvers<null>();
        const timer = setTimeout(() => deadline.resolve(null), 1000);
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
          await waitUntil(
            t,
            () => firstStarted,
            `The first operation for ${label(key)} must start`,
          );
          operations.push(
            mutex.acquire(key, async () => {
              secondStarted = true;
              return false;
            }),
          );
          await delay(settle);
          assert.equal(
            secondStarted,
            false,
            `The second operation for ${label(key)} must wait for the first`,
          );
          finishFirst.resolve();
          const results = await Promise.race([
            Promise.allSettled(operations),
            deadline.promise,
          ]);

          // Assert: these strings are valid resource names, just like product:42.
          assert.notEqual(
            results,
            null,
            `Both operations for ${label(key)} must finish within one second`,
          );
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
          clearTimeout(timer);
        }
      });
    }

    for (const [held, other] of [
      [`${longKey.slice(1)}1`, `${longKey.slice(1)}2`],
      ['report-\uD800', 'report-\uD801'],
      ['report-\uD800', 'report-�'],
    ] as const) {
      test(`resource names ${label(held)} and ${label(other)} are separate locks`, async (t) => {
        // Arrange: one caller holds the first name.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const finishHolder = Promise.withResolvers<void>();
        let holding = false;
        const holder = mutex.acquire(held, async () => {
          holding = true;
          await finishHolder.promise;
        });

        try {
          await waitUntil(
            t,
            () => holding,
            `The holder of ${label(held)} must start`,
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
      });
    }

    test(
      'two HTTP reservations cannot both buy the last item across an async storage step',
      { timeout: 2000 },
      async () => {
        // Arrange: this app and its inventory belong only to this test.
        await using directory = await scratchDirectory();
        const app = new Hono();
        await using host = store.open(directory.path);
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
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
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

    for (const key of ['product:42', longKey]) {
      test(
        `a new store over the same directory keeps issuing newer tokens for resource name ${label(key)}`,
        {
          skip: store.durableTokens
            ? false
            : 'this store keeps its token counter in memory by design',
        },
        async () => {
          // Arrange: one store instance holds the key once, then goes away (e.g. a restart).
          await using directory = await scratchDirectory();
          let before: FencingToken;
          {
            await using previous = store.open(directory.path);
            before = await new Mutex(previous.store).acquire(
              key,
              async (lease) => lease.token,
            );
          }

          // Act: a fresh instance over the same directory holds the key again.
          await using restarted = store.open(directory.path);
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
      );
    }
  });
}

for (const store of storeCases.filter(
  (candidate) =>
    candidate.reach === 'host' || candidate.reach === 'process-tree',
)) {
  describe(`Cross-process mutex with ${store.name}`, () => {
    const workerPrelude = (directory: string) => `
			import { Mutex } from ${JSON.stringify(mutexUrl.href)};
			import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};

			const name = process.argv[1];
			const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory)}));
		`;

    for (const key of ['product:42', longKey]) {
      test(
        `two Node processes using resource name ${label(key)} take turns and both finish`,
        { timeout: 15000 },
        async (t) => {
          // Arrange: the callers have separate memory but share a resource key.
          await using directory = await scratchDirectory();
          await using host = store.open(directory.path);
          const journal = join(directory.path, 'callbacks.log');

          // The log records real callback boundaries; it never grants or blocks a lock.
          const workerSource = `
					import { appendFileSync } from 'node:fs';
					${workerPrelude(directory.path)}
					const finish = Promise.withResolvers();
					const journal = ${JSON.stringify(journal)};

					process.on('message', async (command) => {
						if (command === 'finish') {
							finish.resolve();
							return;
						}
						if (command !== 'start') return;
						process.send({ type: 'attempted' });

						try {
							const result = await mutex.acquire(${JSON.stringify(key)}, async () => {
								appendFileSync(journal, name + ':enter\\n');
								process.send({ type: 'entered' });
								await finish.promise;
								appendFileSync(journal, name + ':leave\\n');
								return name === 'first';
							});
							process.send({ type: 'completed', result }, () => process.exit(0));
						} catch (error) {
							console.error(error);
							process.exit(1);
						}
					});
					process.send({ type: 'ready' });
				`;

          await using first = startWorker(workerSource, 'first', { host });
          await using second = startWorker(workerSource, 'second', { host });
          const stderr = () => first.stderr + second.stderr;
          const waitFor = (condition: () => boolean, message: string) =>
            waitUntil(t, condition, `${message}\n${stderr()}`);

          await waitFor(
            () => first.has('ready') && second.has('ready'),
            'Both Node processes must be ready before the contention scenario starts',
          );

          // Act: first holds the key while second attempts to acquire that same key.
          first.child.send('start');
          await waitFor(
            () => first.has('entered'),
            'The first process must enter its callback',
          );
          second.child.send('start');
          await waitFor(
            () => second.has('attempted'),
            'The second process must attempt the same resource key',
          );
          // Both workers are already running. Keep the first callback open briefly
          // so an unprotected second callback has an opportunity to overlap it.
          await delay(100, undefined, { signal: t.signal });
          first.child.send('finish');
          await waitFor(
            () => first.has('completed') && second.has('entered'),
            'After the first operation finishes, the second process must enter its callback',
          );
          second.child.send('finish');
          await waitFor(
            () => first.exit !== null && second.exit !== null,
            'Both processes must finish their operations and exit',
          );

          // Assert: both callers finish, and the actual callback intervals never overlap.
          assert.deepEqual(
            [first.exit, second.exit],
            [
              { code: 0, signal: null },
              { code: 0, signal: null },
            ],
            `Both worker processes must exit successfully.\n${stderr()}`,
          );
          assert.deepEqual(
            [first, second].map(
              (worker) =>
                worker.messages.find((message) => message.type === 'completed')
                  ?.result,
            ),
            [true, false],
            'Each process must receive its own callback result: true for first, false for second',
          );
          assert.deepEqual(
            (await readFile(journal, 'utf8')).trim().split('\n'),
            ['first:enter', 'first:leave', 'second:enter', 'second:leave'],
            'The second process must not enter the same product callback before the first process leaves it',
          );
        },
      );
    }

    for (const key of ['product:42', longKey]) {
      test(
        `a holder process killed while holding resource name ${label(key)} does not block the next caller`,
        { timeout: 15000 },
        async (t) => {
          // Arrange: another process enters the callback and never leaves it.
          await using directory = await scratchDirectory();
          await using host = store.open(directory.path);
          await using holder = startWorker(
            `
						${workerPrelude(directory.path)}
						setInterval(() => {}, 1000);
						await mutex.acquire(${JSON.stringify(key)}, async () => {
							process.send({ type: 'entered' });
							await new Promise(() => {});
						});
					`,
            'holder',
            { host },
          );
          await waitUntil(
            t,
            () => holder.has('entered'),
            `The holder process must enter its callback.\n${holder.stderr}`,
          );
          const mutex = new Mutex(host.store);
          const deadline = Promise.withResolvers<null>();
          const timer = setTimeout(() => deadline.resolve(null), 2000);

          try {
            // Act: the holder dies without releasing, then this process asks for the same key.
            holder.child.kill('SIGKILL');
            await holder.closed;
            const acquired = await Promise.race([
              mutex.acquire(key, async () => true),
              deadline.promise,
            ]);

            // Assert: the dead holder's lock is recovered instead of blocking forever.
            assert.equal(
              acquired,
              true,
              'A caller must acquire the key within two seconds after its holder process was killed',
            );
          } finally {
            clearTimeout(timer);
          }
        },
      );
    }

    test(
      'four processes incrementing a shared counter never lose an update',
      { timeout: 15000 },
      async () => {
        // Arrange: each increment reads, yields, then writes, so any overlap loses an update.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const counter = join(directory.path, 'counter');
        const tokenJournal = join(directory.path, 'tokens.log');
        await writeFile(counter, '0');
        const increments = 25;
        const source = `
					import { appendFile, readFile, writeFile } from 'node:fs/promises';
					import { setImmediate as nextTurn } from 'node:timers/promises';
					${workerPrelude(directory.path)}
					const counter = ${JSON.stringify(counter)};

					for (let i = 0; i < ${increments}; i++) {
						await mutex.acquire('product:42', async (lease) => {
							await appendFile(${JSON.stringify(tokenJournal)}, lease.token + '\\n');
							const value = Number(await readFile(counter, 'utf8'));
							await nextTurn();
							await writeFile(counter, String(value + 1));
						});
					}
					process.exit(0);
				`;

        // Act: all processes contend for the same key at once.
        await using workers = new AsyncDisposableStack();
        const processes = ['a', 'b', 'c', 'd'].map((name) =>
          workers.use(startWorker(source, name, { host })),
        );
        await Promise.all(processes.map((worker) => worker.closed));

        // Assert: every increment ran exclusively, so none was overwritten.
        assert.deepEqual(
          processes.map((worker) => worker.exit),
          processes.map(() => ({ code: 0, signal: null })),
          `Every worker process must exit successfully.\n${processes.map((worker) => worker.stderr).join('')}`,
        );
        assert.equal(
          await readFile(counter, 'utf8'),
          String(processes.length * increments),
          'Every increment from every process must be preserved',
        );
        const tokens = (await readFile(tokenJournal, 'utf8'))
          .trim()
          .split('\n')
          .map(BigInt);
        assert.ok(
          tokens.every(
            (token, index) => index === 0 || token > tokens[index - 1]!,
          ),
          'Fencing tokens must strictly increase in grant order across every process',
        );
      },
    );

    test(
      'a waiter keeps waiting while the holder is frozen, and gets the key once it resumes and releases',
      {
        timeout: 15000,
        skip:
          process.platform === 'win32'
            ? 'Windows cannot freeze a process with SIGSTOP'
            : false,
      },
      async (t) => {
        // Arrange: this process asks first, so a SocketStore leads from here and
        // freezing the holder never freezes the coordinator.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        await mutex.acquire('warm-up', async () => {});
        const holderSource = `
					${workerPrelude(directory.path)}
					const release = Promise.withResolvers();
					process.on('message', (command) => {
						if (command === 'release') release.resolve();
					});
					await mutex.acquire('product:42', async () => {
						process.send({ type: 'holding' });
						await release.promise;
					});
					process.send({ type: 'released' });
				`;
        await using holder = startWorker(holderSource, 'holder', { host });
        await waitUntil(
          t,
          () => holder.has('holding'),
          `The holder must take the key\n${holder.stderr}`,
        );

        // Act: the holder freezes, and this process waits for the key.
        holder.child.kill('SIGSTOP');
        const waiter = watch(
          mutex.acquire('product:42', async (lease) => lease.token),
        );
        await delay(settle * 10);
        const whileFrozen = waiter.now.status;
        holder.child.kill('SIGCONT');
        holder.child.send('release');

        // Assert: a frozen holder can resume at any time, so its key stays its own.
        assert.equal(
          whileFrozen,
          'pending',
          'A waiter took the key of a frozen holder, which can still resume and write',
        );
        await waitUntil(
          t,
          () => waiter.now.status === 'fulfilled',
          'The waiter must get the key once the holder releases it',
        );
      },
    );
  });
}

/**
 * Worker source that builds the store's thread side, then runs `body` with
 * `mutex`, `parentPort` and `workerData` in scope. Only dynamic imports, because
 * an eval worker is CommonJS or ESM depending on the process that starts it.
 */
const threadSource = (storeName: string, directory: string, body: string) => `
	(async () => {
		const { parentPort, workerData } = await import('node:worker_threads');
		const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
		const { createThreadStore } = await import(${JSON.stringify(storeCasesUrl.href)});
		const mutex = new Mutex(createThreadStore(${JSON.stringify(storeName)}, ${JSON.stringify(directory)}));
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
async function incrementFromFourThreads(store: StoreCase, directory: string) {
  await using host = store.open(directory);
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
      startThread(host, threadSource(store.name, directory, body), shared),
      'exit',
    ),
  );
  for (let i = 0; i < 20; i++) await mutex.acquire('counter', increment);
  await Promise.all(exits);
  return { counter: shared[0], overlaps: shared[2] };
}

for (const store of storeCases.filter(
  (candidate) => candidate.reach === 'process',
)) {
  describe(`Cross-thread mutex with ${store.name}`, () => {
    test(
      'a thread waits while another thread of the same process holds the key',
      { timeout: 5000 },
      async (t) => {
        // Arrange: the main thread holds the key.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const finishMain = Promise.withResolvers<void>();
        const held = mutex.acquire('product:42', () => finishMain.promise);
        const events: string[] = [];
        const thread = startThread(
          host,
          threadSource(
            store.name,
            directory.path,
            `parentPort.postMessage('requested');
						 await mutex.acquire('product:42', async () => parentPort.postMessage('entered'));`,
          ),
        );
        thread.on('message', (event) => {
          if (typeof event === 'string') events.push(event);
        });

        try {
          // Act: the thread asks for the same key while the main thread holds it.
          await waitUntil(
            t,
            () => events.includes('requested'),
            'The thread must start',
          );
          await delay(settle);
          const enteredWhileHeld = events.includes('entered');
          finishMain.resolve();
          await held;

          // Assert
          assert.equal(
            enteredWhileHeld,
            false,
            'The thread entered while the main thread held the key',
          );
          await waitUntil(
            t,
            () => events.includes('entered'),
            'The thread must enter once the main thread releases',
          );
        } finally {
          finishMain.resolve();
          await thread.terminate();
        }
      },
    );

    test(
      'a thread that dies while holding the key does not block the next caller',
      { timeout: 5000 },
      async () => {
        // Arrange: a worker thread enters and stays inside its callback.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const holder = startThread(
          host,
          threadSource(
            store.name,
            directory.path,
            `setInterval(() => {}, 1000);
						 await mutex.acquire('product:42', async () => {
							 parentPort.postMessage('held');
							 await new Promise(() => {});
						 });`,
          ),
        );
        const held = once(holder, 'message');
        const mutex = new Mutex(host.store);
        const deadline = Promise.withResolvers<null>();
        const timer = setTimeout(() => deadline.resolve(null), 2000);

        try {
          await held;
          const next = mutex.acquire('product:42', async () => true);

          // Act: the holding thread is terminated without releasing.
          await holder.terminate();

          // Assert: the waiter is granted instead of waiting forever.
          assert.equal(
            await Promise.race([next, deadline.promise]),
            true,
            'The waiter must acquire within two seconds after the holding thread died',
          );
        } finally {
          clearTimeout(timer);
          await holder.terminate();
        }
      },
    );

    test(
      'a thread whose only pending work is waiting for the key still gets it',
      { timeout: 5000 },
      async () => {
        // Arrange: the main thread holds the key, and the worker thread has nothing to do but wait.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const release = Promise.withResolvers<void>();
        const held = mutex.acquire('product:42', () => release.promise);
        const thread = startThread(
          host,
          threadSource(
            store.name,
            directory.path,
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
      'four threads incrementing a shared counter never overlap or lose an update',
      { timeout: 10000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();

        // Act
        const result = await incrementFromFourThreads(store, directory.path);

        // Assert: one holder at a time, so every increment survives.
        assert.deepEqual(
          result,
          { counter: 80, overlaps: 0 },
          'Two threads held the key at the same time',
        );
      },
    );
  });
}

for (const store of storeCases.filter(
  (candidate) => candidate.reach === 'host',
)) {
  describe(`Threads sharing ${store.name}`, () => {
    test(
      'four threads incrementing a shared counter never overlap or lose an update',
      { timeout: 15000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();

        // Act: each thread builds its own store over the same directory.
        const result = await incrementFromFourThreads(store, directory.path);

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
      { timeout: 15000 },
      async () => {
        // Arrange: this thread asks first, so a SocketStore leads from here and
        // terminating the holder never ends the leader's term.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        await mutex.acquire('warm-up', async () => {});
        const thread = startThread(
          host,
          threadSource(
            store.name,
            directory.path,
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
  });
}

describe('Process-tree mutex with IpcStore', () => {
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
      await using directory = await scratchDirectory();
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
});
