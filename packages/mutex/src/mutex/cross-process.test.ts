import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { describe, test } from '@zukhruf/testing/node';

import { newProcessTimeout } from '../testing/new-process-timeout.ts';
import {
  deadlineFor,
  reaches,
  settle,
  storeCases,
  timeoutForGrants,
} from '../testing/store-cases.ts';
import { watch } from '../testing/watch.ts';
import { startWorker } from '../testing/worker-process.ts';
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

void describe.each(
  storeCases.filter((candidate) => reaches(candidate, 'process-tree')),
  (store) =>
    describe(`Cross-process mutex with ${store.name}`, () => {
      const workerPrelude = (location: string) => `
			import { Mutex } from ${JSON.stringify(mutexUrl.href)};
			import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};

			const name = process.argv[1];
			const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(location)}));
		`;

      void test.each(['product:42', longKey], (key) =>
        test(
          `two Node processes using resource name ${label(key)} take turns and both finish`,
          { timeout: timeoutForGrants(store, 2) },
          async (t) => {
            // Arrange: the callers have separate memory but share a resource key.
            await using fixture = await store.fixture(process.env);
            await using host = store.open(fixture.location);
            await using journals = await new TemporaryFiles().directory(
              'mutex-test-',
            );
            const journal = join(journals.path, 'callbacks.log');

            // The log records real callback boundaries; it never grants or blocks a lock.
            const workerSource = `
					import { appendFileSync } from 'node:fs';
					${workerPrelude(fixture.location)}
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
              t.waitFor(
                () => assert.ok(condition(), `${message}\n${stderr()}`),
                {
                  interval: 5,
                  timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
                },
              );

            await t.waitFor(
              () =>
                assert.ok(
                  first.has('ready') && second.has('ready'),
                  `Both Node processes must be ready before the contention scenario starts\n${stderr()}`,
                ),
              { interval: 5, timeout: newProcessTimeout },
            );

            // Act: first holds the key while second attempts to acquire that same key.
            first.child.send('start');
            // The first acquire of a new process also opens the store.
            await t.waitFor(
              () =>
                assert.ok(
                  first.has('entered'),
                  `The first process must enter its callback\n${stderr()}`,
                ),
              { interval: 5, timeout: newProcessTimeout },
            );
            second.child.send('start');
            await waitFor(
              () => second.has('attempted'),
              'The second process must attempt the same resource key',
            );
            // Both workers are already running. Keep the first callback open briefly
            // so an unprotected second callback has an opportunity to overlap it.
            await delay(
              deadlineFor(store, 100, { grants: 1, releases: 0 }),
              undefined,
              { signal: t.signal },
            );
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
                  worker.messages.find(
                    (message) => message.type === 'completed',
                  )?.result,
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
        ),
      );

      void test.each(['product:42', longKey], (key) =>
        test(
          `a holder process killed while holding resource name ${label(key)} does not block the next caller`,
          { timeout: timeoutForGrants(store, 2) },
          async (t) => {
            // Arrange: another process enters the callback and never leaves it.
            await using fixture = await store.fixture(process.env);
            await using host = store.open(fixture.location);
            await using holder = startWorker(
              `
						${workerPrelude(fixture.location)}
						setInterval(() => {}, 1000);
						await mutex.acquire(${JSON.stringify(key)}, async () => {
							process.send({ type: 'entered' });
							await new Promise(() => {});
						});
					`,
              'holder',
              { host },
            );
            await t.waitFor(
              () =>
                assert.ok(
                  holder.has('entered'),
                  `The holder process must enter its callback.\n${holder.stderr}`,
                ),
              { interval: 5, timeout: newProcessTimeout },
            );
            const mutex = new Mutex(host.store);
            const limit = deadlineFor(store, 2000, { grants: 1, releases: 1 });
            const deadline = delay(limit, null, { ref: false });

            // Act: the holder dies without releasing, then this process asks for the same key.
            holder.child.kill('SIGKILL');
            await holder.closed;
            const acquired = await Promise.race([
              mutex.acquire(key, async () => true),
              deadline,
            ]);

            // Assert: the dead holder's lock is recovered instead of blocking forever.
            assert.equal(
              acquired,
              true,
              `A caller must acquire the key within ${limit} ms after its holder process was killed`,
            );
          },
        ),
      );

      test(
        'four processes incrementing a shared counter never lose an update',
        // Four processes make 25 grants each.
        { timeout: timeoutForGrants(store, 100) },
        async () => {
          // Arrange: each increment reads, yields, then writes, so any overlap loses an update.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          await using journals = await new TemporaryFiles().directory(
            'mutex-test-',
          );
          const counter = join(journals.path, 'counter');
          const tokenJournal = join(journals.path, 'tokens.log');
          await writeFile(counter, '0');
          const increments = 25;
          const source = `
					import { appendFile, readFile, writeFile } from 'node:fs/promises';
					import { setImmediate as nextTurn } from 'node:timers/promises';
					${workerPrelude(fixture.location)}
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
          timeout: timeoutForGrants(store, 3),
          skip:
            process.platform === 'win32'
              ? 'Windows cannot freeze a process with SIGSTOP'
              : false,
        },
        async (t) => {
          // Arrange: this process asks first, so a SocketStore leads from here and
          // freezing the holder never freezes the coordinator.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          await mutex.acquire('warm-up', async () => {});
          const holderSource = `
					${workerPrelude(fixture.location)}
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
          await t.waitFor(
            () =>
              assert.ok(
                holder.has('holding'),
                `The holder must take the key\n${holder.stderr}`,
              ),
            { interval: 5, timeout: newProcessTimeout },
          );

          // Act: the holder freezes, and this process waits for the key.
          holder.child.kill('SIGSTOP');
          const waiter = watch(
            mutex.acquire('product:42', async (lease) => lease.token),
          );
          await delay(
            deadlineFor(store, settle * 10, { grants: 1, releases: 0 }),
          );
          const whileFrozen = waiter.now.status;
          holder.child.kill('SIGCONT');
          holder.child.send('release');

          // Assert: a frozen holder can resume at any time, so its key stays its own.
          assert.equal(
            whileFrozen,
            'pending',
            'A waiter took the key of a frozen holder, which can still resume and write',
          );
          await t.waitFor(
            () =>
              assert.ok(
                waiter.now.status === 'fulfilled',
                'The waiter must get the key once the holder releases it',
              ),
            {
              interval: 5,
              timeout: deadlineFor(store, 2000, { grants: 1, releases: 0 }),
            },
          );
        },
      );
    }),
);
