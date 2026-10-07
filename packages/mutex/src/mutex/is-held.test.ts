import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { isRecord } from '../shared/is-record.ts';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import { type StoreHost, storeCases } from '../testing/store-cases.ts';
import { newProcessTimeout, waitUntil } from '../testing/wait-until.ts';
import { startWorker } from '../testing/worker-process.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

const mutexUrl = new URL('./mutex.ts', import.meta.url);
const storeCasesUrl = new URL('../testing/store-cases.ts', import.meta.url);

for (const store of storeCases) {
  describe(`Holder check with ${store.name}`, () => {
    test('a key reads as held only while a task holds it', async () => {
      // Arrange
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
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
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
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

    test('looks take no fencing token and change no file', async () => {
      // Arrange
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
      const mutex = new Mutex(host.store);
      const lookTwenty = async () => {
        for (let look = 0; look < 20; look++) {
          await mutex.isHeld('report:daily');
        }
      };

      // Act: look while the key is held, then while it is free, between two grants.
      const held = await mutex.acquire('report:daily', async ({ token }) => {
        const files = await filesIn(directory.path);
        await lookTwenty();
        return { token, files, filesAfterLooks: await filesIn(directory.path) };
      });
      const files = await filesIn(directory.path);
      await lookTwenty();
      const filesAfterLooks = await filesIn(directory.path);
      const next = await mutex.acquire(
        'report:daily',
        async ({ token }) => token,
      );

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
      assert.equal(
        next.value,
        held.token.value + 1n,
        'Looks between two grants must take no token',
      );
    });
  });
}

for (const store of storeCases.filter(
  (candidate) => candidate.reach === 'host',
)) {
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
        await using directory = await scratchDirectory();
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
  });
}

for (const store of storeCases.filter((candidate) => candidate.openInThread)) {
  describe(`Holder check from a worker thread with ${store.name}`, () => {
    test(
      'looks from another thread never make a caller that skips if busy give up on a free key',
      { timeout: 15000 },
      async (t) => {
        // Arrange: a worker thread looks at the key again and again until it is told to stop.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        // [stop, looks made]
        const shared = new Int32Array(new SharedArrayBuffer(8));
        const looker = startThread(
          host,
          threadSource(
            store.name,
            directory.path,
            `
						const shared = workerData;
						while (Atomics.load(shared, 0) === 0) {
							await mutex.isHeld('report:daily');
							Atomics.add(shared, 1, 1);
						}
					`,
          ),
          shared,
        );
        try {
          await waitUntil(
            t,
            () => Atomics.load(shared, 1) > 0,
            'The worker thread must start looking',
            newProcessTimeout,
          );

          // Act: the key is free each time; the attempts go on until 200 looks ran among them.
          const looksBefore = Atomics.load(shared, 1);
          const results = [];
          while (
            results.length < 50 ||
            Atomics.load(shared, 1) - looksBefore < 200
          ) {
            results.push(
              await mutex.acquire('report:daily', async () => 'ran', {
                mode: Modes.skipIfBusy(),
              }),
            );
            // A memory coordinator answers in microtasks; the turn lets the looks it serves in.
            await nextTurn();
          }

          // Assert
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
  });
}

for (const store of storeCases.filter(
  (candidate) =>
    candidate.reach === 'host' || candidate.reach === 'process-tree',
)) {
  describe(`Holder check across processes with ${store.name}`, () => {
    const childPrelude = (directory: string) => `
			import { Mutex } from ${JSON.stringify(mutexUrl.href)};
			import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};

			const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory)}));
		`;
    const holderSource = (directory: string) => `
			${childPrelude(directory)}
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
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        await using holder = startWorker(
          holderSource(directory.path),
          'holder',
          { host },
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The holder process must enter its task.\n${holder.stderr}`,
          newProcessTimeout,
        );
        const mutex = new Mutex(host.store);

        // Act
        const whileAlive = await mutex.isHeld('report:daily');
        holder.child.kill('SIGKILL');
        await holder.closed;
        const afterKill = await mutex.isHeld('report:daily');

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
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        await using holder = startWorker(
          holderSource(directory.path),
          'holder',
          { host },
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The holder process must enter its task.\n${holder.stderr}`,
          newProcessTimeout,
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
            : false,
      },
      async (t) => {
        // Arrange: a holder process dies while it holds the key, and leaves its files.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        await using holder = startWorker(
          holderSource(directory.path),
          'holder',
          { host },
        );
        await waitUntil(
          t,
          () => holder.has('entered'),
          () => `The holder process must enter its task.\n${holder.stderr}`,
          newProcessTimeout,
        );
        holder.child.kill('SIGKILL');
        await holder.closed;
        const mutex = new Mutex(host.store);
        const files = await filesIn(directory.path);

        // Act
        for (let look = 0; look < 5; look++) {
          await mutex.isHeld('report:daily');
        }

        // Assert: only a caller that acquires removes a gone holder.
        assert.deepEqual(await filesIn(directory.path), files);
      },
    );

    test(
      'a look from a child process sees a holder in this process',
      { timeout: 30000 },
      async (t) => {
        // Arrange: this process holds the key until the child has looked.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
							${childPrelude(directory.path)}
							process.send({ type: 'looked', held: await mutex.isHeld('report:daily') });
						`,
            'looker',
            { host },
          );
          await waitUntil(
            t,
            () => looker.has('looked'),
            () => `The child must report its look.\n${looker.stderr}`,
            newProcessTimeout,
          );

          // Assert
          assert.equal(looker.find('looked')?.held, true);
        } finally {
          release.resolve();
          await holding;
        }
      },
    );
  });
}

for (const store of storeCases.filter(
  (candidate) => candidate.reach === 'process',
)) {
  describe(`Holder check across threads with ${store.name}`, () => {
    test(
      'a look from a worker thread sees a holder in this thread',
      { timeout: 15000 },
      async () => {
        // Arrange: this thread holds the key until the worker has looked.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
              directory.path,
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
  });
}

/**
 * Worker source that builds the store's thread side, then runs `body` with
 * `mutex`, `parentPort` and `workerData` in scope. Only dynamic imports, because an eval
 * worker is CommonJS or ESM depending on the process that starts it.
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
