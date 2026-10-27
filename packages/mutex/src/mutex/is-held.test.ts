import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { describe } from '@zukhruf/testing/node';

import { isRecord } from '../shared/is-record.ts';
import { newProcessTimeout } from '../testing/new-process-timeout.ts';
import {
  type StoreHost,
  reaches,
  storeCases,
  timeoutForGrants,
} from '../testing/store-cases.ts';
import { startWorker } from '../testing/worker-process.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

const mutexUrl = new URL('./mutex.ts', import.meta.url);
const storeCasesUrl = new URL('../testing/store-cases.ts', import.meta.url);

void describe.each(storeCases, (store) =>
  describe(`Holder check with ${store.name}`, () => {
    test('a key reads as held only while a task holds it', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);

      // Act
      const before = await mutex.isHeld('report:daily');
      const during = await mutex.acquire('report:daily', () =>
        mutex.isHeld('report:daily'),
      );
      const after = await mutex.isHeld('report:daily');

      // Assert
      assert.deepEqual(
        { before, during, after },
        { before: false, during: true, after: false },
      );
    });

    test('a key answers for its own name, not for another key', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const daily = mutex.key('report:daily');
      const weekly = mutex.key('report:weekly');

      // Act
      const seen = await daily.run(async () => ({
        daily: await daily.isHeld(),
        weekly: await weekly.isHeld(),
      }));

      // Assert
      assert.deepEqual(seen, { daily: true, weekly: false });
    });

    test(
      'looks take no fencing token',
      {
        skip:
          store.name === 'DockerEngineStore'
            ? 'Its tokens follow the clock of the engine, so the next token is not the last + 1; "isHeld tells a held key from a free one and creates nothing" proves that a look mints no rung'
            : false,
      },
      async () => {
        // Arrange
        await using fixture = await store.fixture(process.env);
        await using host = store.open(fixture.location);
        const mutex = new Mutex(host.store);
        const lookTwenty = async () => {
          for (let look = 0; look < 20; look++) {
            await mutex.isHeld('report:daily');
          }
        };

        // Act: look while the key is held, then while it is free, between two grants.
        const held = await mutex.acquire('report:daily', async ({ token }) => {
          await lookTwenty();
          return token;
        });
        await lookTwenty();
        const next = await mutex.acquire(
          'report:daily',
          async ({ token }) => token,
        );

        // Assert
        assert.equal(
          next.value,
          held.value + 1n,
          'Looks between two grants must take no token',
        );
      },
    );

    test(
      'looks change no file',
      {
        skip: reaches(store, 'network')
          ? 'A network lock store keeps no files'
          : false,
      },
      async () => {
        // Arrange
        await using fixture = await store.fixture(process.env);
        await using host = store.open(fixture.location);
        const mutex = new Mutex(host.store);
        const lookTwenty = async () => {
          for (let look = 0; look < 20; look++) {
            await mutex.isHeld('report:daily');
          }
        };

        // Act: look while the key is held, then while it is free.
        const held = await mutex.acquire('report:daily', async () => {
          const files = await filesIn(fixture.location);
          await lookTwenty();
          return { files, filesAfterLooks: await filesIn(fixture.location) };
        });
        const files = await filesIn(fixture.location);
        await lookTwenty();
        const filesAfterLooks = await filesIn(fixture.location);

        // Assert
        assert.deepEqual(
          held.filesAfterLooks,
          held.files,
          'Looks at a held key must not write',
        );
        assert.deepEqual(
          filesAfterLooks,
          files,
          'Looks at a free key must not write',
        );
      },
    );
  }),
);

void describe.each(
  storeCases.filter((candidate) => candidate.reach === 'host'),
  (store) =>
    describe(`Holder check in a directory that does not exist with ${store.name}`, () => {
      test(
        'a look answers that nobody holds the key, and makes no directory',
        {
          skip:
            store.name === 'SocketStore'
              ? 'A look that finds no leader campaigns to lead, and a campaign makes the directory'
              : false,
        },
        async () => {
          // Arrange
          await using directory = await new TemporaryFiles().directory(
            'mutex-test-',
          );
          const locks = join(directory.path, 'locks');
          await using host = store.open(locks);
          const mutex = new Mutex(host.store);

          // Act
          const held = await mutex.isHeld('report:daily');

          // Assert
          assert.equal(held, false);
          assert.deepEqual(await readdir(directory.path), []);
        },
      );
    }),
);

void describe.each(
  storeCases.filter((candidate) => candidate.openInThread),
  (store) =>
    describe(`Holder check from a worker thread with ${store.name}`, () => {
      test(
        'looks from another thread never make a caller that skips if busy give up on a free key',
        // 50 attempts, each one a grant of the free key, and 50 looks that cost no more than a grant.
        { timeout: timeoutForGrants(store, 100) },
        async () => {
          // Arrange: a worker thread starts one look each time it is asked, and tells when the look is in flight and when it is done.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          // [stop, looks done, looks asked for, looks started]
          const shared = new Int32Array(new SharedArrayBuffer(16));
          const looker = startThread(
            host,
            threadSource(
              store.name,
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
        },
      );
    }),
);

void describe.each(
  storeCases.filter((candidate) => reaches(candidate, 'process-tree')),
  (store) =>
    describe(`Holder check across processes with ${store.name}`, () => {
      const childPrelude = (location: string) => `
			import { Mutex } from ${JSON.stringify(mutexUrl.href)};
			import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};

			const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(location)}));
		`;
      const holderSource = (location: string) => `
			${childPrelude(location)}
			setInterval(() => {}, 1000);
			await mutex.acquire('report:daily', async () => {
				process.send({ type: 'entered' });
				await new Promise(() => {});
			});
		`;

      test(
        'a look sees a holder in another process, and no holder once that process is killed',
        { timeout: 30000 },
        async (t) => {
          // Arrange: another process holds the key and never lets it go.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          await using holder = startWorker(
            holderSource(fixture.location),
            'holder',
            { host },
          );
          await t.waitFor(
            () =>
              assert.ok(
                holder.has('entered'),
                `The holder process must enter its task.\n${holder.stderr}`,
              ),
            { interval: 5, timeout: newProcessTimeout },
          );
          const mutex = new Mutex(host.store);

          // Act
          const whileAlive = await mutex.isHeld('report:daily');
          holder.child.kill('SIGKILL');
          await holder.closed;
          // The store sees the end of the holder at most releaseLatency after its process closed.
          const releasedBy = performance.now() + store.releaseLatency;
          let afterKill = await mutex.isHeld('report:daily');
          while (afterKill && performance.now() < releasedBy) {
            afterKill = await mutex.isHeld('report:daily');
          }

          // Assert
          assert.deepEqual(
            { whileAlive, afterKill },
            { whileAlive: true, afterKill: false },
          );
        },
      );

      test(
        'after a killed holder, the next holder reads as held, and nobody once it ends',
        { timeout: 30000 },
        async (t) => {
          // Arrange: a holder process dies while it holds the key.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          await using holder = startWorker(
            holderSource(fixture.location),
            'holder',
            { host },
          );
          await t.waitFor(
            () =>
              assert.ok(
                holder.has('entered'),
                `The holder process must enter its task.\n${holder.stderr}`,
              ),
            { interval: 5, timeout: newProcessTimeout },
          );
          holder.child.kill('SIGKILL');
          await holder.closed;
          const mutex = new Mutex(host.store);

          // Act
          const during = await mutex.acquire('report:daily', () =>
            mutex.isHeld('report:daily'),
          );
          const after = await mutex.isHeld('report:daily');

          // Assert
          assert.deepEqual({ during, after }, { during: true, after: false });
        },
      );

      test(
        'a look leaves the files of a killed holder as they are',
        {
          timeout: 30000,
          skip:
            store.name === 'SocketStore'
              ? 'A look that finds no leader campaigns to lead, and a campaign writes the term'
              : reaches(store, 'network')
                ? 'A network lock store keeps no files'
                : false,
        },
        async (t) => {
          // Arrange: a holder process dies while it holds the key, and leaves its files.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          await using holder = startWorker(
            holderSource(fixture.location),
            'holder',
            { host },
          );
          await t.waitFor(
            () =>
              assert.ok(
                holder.has('entered'),
                `The holder process must enter its task.\n${holder.stderr}`,
              ),
            { interval: 5, timeout: newProcessTimeout },
          );
          holder.child.kill('SIGKILL');
          await holder.closed;
          const mutex = new Mutex(host.store);
          const files = await filesIn(fixture.location);

          // Act
          for (let look = 0; look < 5; look++) {
            await mutex.isHeld('report:daily');
          }

          // Assert: only a caller that acquires removes a gone holder.
          assert.deepEqual(await filesIn(fixture.location), files);
        },
      );

      test(
        'a look from a child process sees a holder in this process',
        { timeout: 30000 },
        async (t) => {
          // Arrange: this process holds the key until the child has looked.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const holding = mutex.acquire('report:daily', async () => {
            entered.resolve();
            await release.promise;
          });
          try {
            await entered.promise;

            // Act
            await using looker = startWorker(
              `
							${childPrelude(fixture.location)}
							process.send({ type: 'looked', held: await mutex.isHeld('report:daily') });
						`,
              'looker',
              { host },
            );
            await t.waitFor(
              () =>
                assert.ok(
                  looker.has('looked'),
                  `The child must report its look.\n${looker.stderr}`,
                ),
              { interval: 5, timeout: newProcessTimeout },
            );

            // Assert
            assert.equal(looker.find('looked')?.held, true);
          } finally {
            release.resolve();
            await holding;
          }
        },
      );
    }),
);

void describe.each(
  storeCases.filter((candidate) => candidate.reach === 'process'),
  (store) =>
    describe(`Holder check across threads with ${store.name}`, () => {
      test(
        'a look from a worker thread sees a holder in this thread',
        { timeout: timeoutForGrants(store, 2) },
        async () => {
          // Arrange: this thread holds the key until the worker has looked.
          await using fixture = await store.fixture(process.env);
          await using host = store.open(fixture.location);
          const mutex = new Mutex(host.store);
          const entered = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const holding = mutex.acquire('report:daily', async () => {
            entered.resolve();
            await release.promise;
          });
          try {
            await entered.promise;

            // Act
            const looker = startThread(
              host,
              threadSource(
                store.name,
                fixture.location,
                `parentPort.postMessage({ looked: await mutex.isHeld('report:daily') });`,
              ),
            );
            const held = await lookFrom(looker);
            await looker.terminate();

            // Assert
            assert.equal(held, true);
          } finally {
            release.resolve();
            await holding;
          }
        },
      );
    }),
);

/**
 * Worker source that builds the store's thread side, then runs `body` with
 * `mutex`, `parentPort` and `workerData` in scope. Only dynamic imports, because an eval
 * worker is CommonJS or ESM depending on the process that starts it.
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

/** The answer a worker thread reports; the thread's lock requests share its port. */
function lookFrom(worker: Worker): Promise<unknown> {
  return new Promise((resolve) => {
    worker.on('message', (message: unknown) => {
      if (isRecord(message) && 'looked' in message) resolve(message.looked);
    });
  });
}

/** Starts a worker thread that the host adopts before it can ask for a key. */
function startThread(host: StoreHost, source: string, workerData?: unknown) {
  const thread = new Worker(source, { eval: true, workerData });
  host.adoptThread(thread);
  return thread;
}

/** Each file under `directory` with its inode, size and change time, so that any write shows. */
async function filesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        const { ino, size, mtimeNs } = await stat(path, { bigint: true });
        return `${relative(directory, path)} ${ino} ${size} ${mtimeNs}`;
      }),
  );
  return files.sort();
}
