import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { LockFileStore } from './lock-file-store.ts';
import { TicketQueueFileStore } from './ticket-queue-file-store.ts';

const mutexUrl = new URL('../../mutex/mutex.ts', import.meta.url);
const modesUrl = new URL('../../mutex/acquire-modes/modes.ts', import.meta.url);
const registerUrl = new URL(
  '../../testing/fenced-register.ts',
  import.meta.url,
);

const stores = [
  {
    name: 'LockFileStore',
    url: new URL('./lock-file-store.ts', import.meta.url),
    create: (directory: string) =>
      new LockFileStore(directory, { pollInterval: 10 }),
  },
  {
    name: 'TicketQueueFileStore',
    url: new URL('./ticket-queue-file-store.ts', import.meta.url),
    create: (directory: string) =>
      new TicketQueueFileStore(directory, { pollInterval: 10 }),
  },
] as const;

type Store = (typeof stores)[number];

const ticketQueue = stores[1];

const posixOnly =
  process.platform === 'win32'
    ? 'Windows has no zombies, no sh, and no read-only directories'
    : false;

/**
 * A caller in its own process that asks for the key, waiting as long as it
 * takes. It reports over IPC when it has one, otherwise on stdout, and holds
 * the key until told to release it.
 */
const callerSource = (store: Store, directory: string) => `
	import { Mutex } from ${JSON.stringify(mutexUrl.href)};
	import { ${store.name} } from ${JSON.stringify(store.url.href)};
	const report = (message) =>
		process.send ? process.send(message) : console.log(JSON.stringify(message));
	const release = Promise.withResolvers();
	process.on('message', (command) => command === 'release' && release.resolve());
	setInterval(() => {}, 1000);
	const mutex = new Mutex(new ${store.name}(${JSON.stringify(directory)}, { pollInterval: 10 }));
	report({ type: 'asking', pid: process.pid });
	try {
		await mutex.acquire('product-42', async () => {
			report({ type: 'holding', pid: process.pid });
			await release.promise;
		});
		report({ type: 'released' });
	} catch (error) {
		report({ type: 'release failed', message: String(error) });
	}
`;

/** Asks once without waiting, the way a cron tick skips a busy job. */
const skipOnce = (store: Store, directory: string) =>
  new Mutex(store.create(directory)).acquire(
    'product-42',
    async () => 'got it',
    { mode: Modes.skipIfBusy({ waitAtMost: 2000 }) },
  );

const presenceFilesIn = async (directory: string) =>
  (await readdir(directory)).filter((file) => file.endsWith('.presence'));

/** Takes the key once and gives it back, which also evicts any gone caller ahead of it. */
const takeAndRelease = (store: Store, directory: string) =>
  new Mutex(store.create(directory)).acquire('product-42', async () => {}, {
    signal: AbortSignal.timeout(5000),
  });

const ticketsIn = (queue: string) => {
  try {
    return readFileSync(queue, 'utf8').split('\n').length - 1;
  } catch {
    return 0;
  }
};

for (const store of stores) {
  describe(`${store.name}: a caller that is gone`, () => {
    test(
      'a waiter gets the key of a holder that died but was never reaped',
      { skip: posixOnly, timeout: 20_000 },
      async (t) => {
        // Arrange: the shell starts the holder and then becomes `sleep`, which
        // never reaps it, so the killed holder stays a zombie that still
        // answers kill(pid, 0). Platform setup that no operation exposes.
        await using directory = await scratchDirectory();
        const shell = spawn(
          'sh',
          [
            '-c',
            `"${process.execPath}" --input-type=module --eval "$SOURCE" & exec sleep 1000`,
          ],
          {
            env: {
              ...process.env,
              SOURCE: callerSource(store, directory.path),
            },
            stdio: ['ignore', 'pipe', 'inherit'],
          },
        );
        try {
          let holder: { pid: number } | undefined;
          createInterface({ input: shell.stdout }).on('line', (line) => {
            const message = JSON.parse(line);
            if (message.type === 'holding') holder = message;
          });
          await waitUntil(
            t,
            () => holder !== undefined,
            'The holder must take the key',
            5000,
          );
          process.kill(holder!.pid, 'SIGKILL');
          await waitUntil(
            t,
            () =>
              execFileSync('ps', ['-o', 'stat=', '-p', String(holder!.pid)], {
                encoding: 'utf8',
              }).startsWith('Z'),
            'The killed holder must stay a zombie',
          );

          // Act
          const result = await skipOnce(store, directory.path);

          // Assert: a zombie runs no code, so its key is free.
          assert.deepEqual(result, { acquired: true, value: 'got it' });
        } finally {
          shell.kill('SIGKILL');
          await once(shell, 'close');
        }
      },
    );

    test(
      'a holder whose release cannot remove its record frees the key anyway',
      { skip: posixOnly, timeout: 20_000 },
      async (t) => {
        // Arrange: a holder in another process holds the key, then the
        // directory turns read-only, so its release cannot remove the record.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          callerSource(store, directory.path),
          'holder',
        );
        await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
        await chmod(directory.path, 0o555);
        try {
          // Act
          holder.child.send('release');
          await waitUntil(
            t,
            () => holder.has('release failed') || holder.has('released'),
            holder.stderr,
            5000,
          );
          assert.ok(
            holder.has('release failed'),
            'The release must fail while the directory is read-only',
          );
        } finally {
          await chmod(directory.path, 0o755);
        }

        // Assert: the holder's process lives on, but it holds nothing any more.
        const result = await skipOnce(store, directory.path);
        assert.deepEqual(result, { acquired: true, value: 'got it' });
      },
    );

    test(
      'a lock record without a presence file fails the acquire with both file names',
      { timeout: 20_000 },
      async () => {
        // Arrange: an older version wrote the record, naming this live
        // process, and keeps no presence file. Platform setup that no
        // operation of this version exposes.
        await using directory = await scratchDirectory();
        const id = randomUUID();
        const record = join(directory.path, 'product-42.lock');
        await writeFile(
          record,
          `${JSON.stringify({ pid: process.pid, host: hostname(), id })}\n`,
        );

        // Act
        const acquiring = new Mutex(store.create(directory.path)).acquire(
          'product-42',
          async () => {},
          { signal: AbortSignal.timeout(3000) },
        );

        // Assert: the waiter names what is in the way instead of guessing,
        // and leaves the record of the caller it cannot judge in place.
        await assert.rejects(acquiring, (error: unknown) => {
          assert.ok(error instanceof Error, String(error));
          assert.match(error.message, /older version/);
          // The message quotes the path as JSON, which doubles each Windows backslash.
          assert.ok(
            error.message.includes(JSON.stringify(record)),
            error.message,
          );
          assert.ok(error.message.includes(`${id}.presence`), error.message);
          return true;
        });
        assert.ok(
          (await readFile(record, 'utf8')).includes(id),
          'The record of a caller that may still run must not be evicted',
        );
      },
    );
  });

  describe(`${store.name}: presence files`, () => {
    test('a released key leaves no presence file', async () => {
      // Arrange
      await using directory = await scratchDirectory();

      // Act
      const whileHeld = await new Mutex(store.create(directory.path)).acquire(
        'product-42',
        () => presenceFilesIn(directory.path),
      );

      // Assert: one presence file while the key is held, none after.
      assert.equal(whileHeld.length, 1, `While held: ${whileHeld}`);
      assert.deepEqual(await presenceFilesIn(directory.path), []);
    });

    test(
      'a holder that was killed leaves no presence file once a waiter takes its key',
      { timeout: 20_000 },
      async (t) => {
        // Arrange
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          callerSource(store, directory.path),
          'holder',
        );
        await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
        assert.equal((await presenceFilesIn(directory.path)).length, 1);
        holder.child.kill('SIGKILL');
        await holder.closed;

        // Act
        await takeAndRelease(store, directory.path);

        // Assert
        assert.deepEqual(await presenceFilesIn(directory.path), []);
      },
    );

    test(
      'callers that ask for a free key at the same moment leave one holder and no presence file',
      { timeout: 20_000 },
      async () => {
        // Arrange: twenty callers in this process skip the key if it is busy.
        await using directory = await scratchDirectory();
        const mutex = new Mutex(store.create(directory.path));

        // Act: all of them ask at once, and the winner holds the key for a moment.
        const results = await Promise.all(
          Array.from({ length: 20 }, () =>
            mutex.acquire(
              'product-42',
              () => new Promise((resolve) => setTimeout(resolve, 50)),
              { mode: Modes.skipIfBusy() },
            ),
          ),
        );
        await takeAndRelease(store, directory.path);

        // Assert: one caller held the key, and every caller that lost left nothing behind.
        assert.equal(results.filter((result) => result.acquired).length, 1);
        assert.deepEqual(await presenceFilesIn(directory.path), []);
      },
    );

    test(
      'a presence file that cannot be read fails the acquire instead of passing for missing',
      { skip: posixOnly, timeout: 20_000 },
      async (t) => {
        // Arrange: a live holder whose presence file nobody else may read.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          callerSource(store, directory.path),
          'holder',
        );
        await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
        const [presence] = await presenceFilesIn(directory.path);
        assert.ok(presence, 'The holder must keep a presence file');
        await chmod(join(directory.path, presence), 0o000);

        // Act
        const acquiring = skipOnce(store, directory.path);

        // Assert: the fault surfaces as it is, not as a record without a presence.
        await assert.rejects(acquiring, (error: unknown) => {
          assert.ok(error instanceof Error, String(error));
          assert.match(error.message, /unable to open/);
          assert.doesNotMatch(error.message, /no presence file/);
          return true;
        });
      },
    );
  });

  test(
    `${store.name}: busy processes that wait, skip and give up never hold the key together`,
    { timeout: 60_000 },
    async (t) => {
      // Arrange: each process takes the key 30 times, in turn waiting,
      // skipping at once, and giving up after 5 ms.
      await using directory = await scratchDirectory();
      const journal = join(directory.path, 'journal.log');
      const source = `
        import { appendFileSync } from 'node:fs';
        import { Mutex } from ${JSON.stringify(mutexUrl.href)};
        import { Modes } from ${JSON.stringify(modesUrl.href)};
        import { FencedRegister } from ${JSON.stringify(registerUrl.href)};
        import { ${store.name} } from ${JSON.stringify(store.url.href)};
        const name = process.argv[1];
        const directory = ${JSON.stringify(directory.path)};
        const mutex = new Mutex(new ${store.name}(directory, { pollInterval: 5 }));
        // Opened inside the task, so the key serializes every write to the register, its creation too.
        let register;
        const modes = [Modes.wait(), Modes.skipIfBusy(), Modes.skipIfBusy({ waitAtMost: 5 })];
        let stale = 0;
        try {
          for (let round = 0; round < 30; round++) {
            await mutex.acquire('product-42', async (lease) => {
              appendFileSync(${JSON.stringify(journal)}, name + ':enter\\n');
              register ??= new FencedRegister(directory + '/register.db');
              if (register.write(lease.token) === 'stale') stale++;
              await new Promise((resolve) => setTimeout(resolve, 1));
              appendFileSync(${JSON.stringify(journal)}, name + ':leave\\n');
            }, { mode: modes[round % modes.length] });
          }
          process.send({ type: 'done', stale });
        } catch (error) {
          process.send({ type: 'failed', message: String(error && error.stack || error) });
        }
      `;
      const workers = ['a', 'b', 'c', 'd'].map((name) =>
        startWorker(source, name),
      );
      try {
        // Act
        await waitUntil(
          t,
          () => workers.every((w) => w.has('done') || w.has('failed')),
          'Every process must finish its rounds',
          50_000,
        ).catch((error: unknown) => {
          throw new Error(workers.map((w) => w.stderr).join(''), {
            cause: error,
          });
        });

        // Assert: no caller failed, no write was fenced off, and no two callers were inside at once.
        assert.deepEqual(
          workers.map((w) => w.find('failed')?.message).filter(Boolean),
          [],
        );
        assert.deepEqual(
          workers.map((w) => w.find('done')?.stale),
          [0, 0, 0, 0],
        );
        const lines = (await readFile(journal, 'utf8')).trim().split('\n');
        for (let index = 0; index < lines.length; index += 2) {
          const [who, step] = lines[index]!.split(':');
          assert.equal(step, 'enter', `line ${index}: ${lines[index]}`);
          assert.equal(
            lines[index + 1],
            `${who}:leave`,
            `Two callers held the key at once at line ${index + 1}`,
          );
        }
      } finally {
        for (const worker of workers) await worker[Symbol.asyncDispose]();
      }
    },
  );
}

describe('TicketQueueFileStore: presence files of waiters', () => {
  const queueIn = (directory: string) => join(directory, 'product-42.lock');

  test(
    'a waiter that was killed in line leaves no presence file once the key moves past it',
    { timeout: 20_000 },
    async (t) => {
      // Arrange: a waiter lines up behind a holder and is killed there.
      await using directory = await scratchDirectory();
      await using holder = startWorker(
        callerSource(ticketQueue, directory.path),
        'holder',
      );
      await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
      await using waiter = startWorker(
        callerSource(ticketQueue, directory.path),
        'waiter',
      );
      await waitUntil(
        t,
        () => ticketsIn(queueIn(directory.path)) === 2,
        'The waiter must be in line',
        5000,
      );
      assert.equal((await presenceFilesIn(directory.path)).length, 2);
      waiter.child.kill('SIGKILL');
      await waiter.closed;
      holder.child.send('release');
      await waitUntil(t, () => holder.has('released'), holder.stderr, 5000);

      // Act
      await takeAndRelease(ticketQueue, directory.path);

      // Assert
      assert.deepEqual(await presenceFilesIn(directory.path), []);
    },
  );

  for (const [ending, endWait] of [
    [
      'gives up',
      (mutex: Mutex) =>
        mutex.acquire('product-42', async () => {}, {
          mode: Modes.skipIfBusy({ waitAtMost: 50 }),
        }),
    ],
    [
      'cancels',
      async (mutex: Mutex, linedUp: () => Promise<void>) => {
        // A cancelled call rejects at once, while its lock store may still be
        // lining it up: cancel only once the waiter is in the queue.
        const cancel = new AbortController();
        const waiting = mutex
          .acquire('product-42', async () => {}, { signal: cancel.signal })
          .catch((error: unknown) => error);
        await linedUp();
        cancel.abort();
        return waiting;
      },
    ],
  ] as const) {
    test(
      `a waiter that ${ending} leaves its ticket for an evicter, and no presence file once the key moves past it`,
      { timeout: 20_000 },
      async (t) => {
        // Arrange: a waiter lines up behind a holder and ends its wait.
        await using directory = await scratchDirectory();
        await using holder = startWorker(
          callerSource(ticketQueue, directory.path),
          'holder',
        );
        await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
        await endWait(new Mutex(ticketQueue.create(directory.path)), () =>
          waitUntil(
            t,
            () => ticketsIn(queueIn(directory.path)) === 2,
            `The waiter must line up behind the holder.\n${holder.stderr}`,
            5000,
          ),
        );
        assert.equal(ticketsIn(queueIn(directory.path)), 2);
        assert.equal((await presenceFilesIn(directory.path)).length, 2);
        holder.child.send('release');
        await waitUntil(t, () => holder.has('released'), holder.stderr, 5000);

        // Act
        await takeAndRelease(ticketQueue, directory.path);

        // Assert
        assert.deepEqual(await presenceFilesIn(directory.path), []);
      },
    );
  }
});

test(
  'TicketQueueFileStore: a skip gets a key whose queue holds only callers that are gone',
  { timeout: 20_000 },
  async (t) => {
    // Arrange: a holder and two waiters line up, then all three die.
    await using directory = await scratchDirectory();
    const queue = join(directory.path, 'product-42.lock');
    await using holder = startWorker(
      callerSource(ticketQueue, directory.path),
      'holder',
    );
    await waitUntil(t, () => holder.has('holding'), holder.stderr, 5000);
    await using first = startWorker(
      callerSource(ticketQueue, directory.path),
      'first',
    );
    await using second = startWorker(
      callerSource(ticketQueue, directory.path),
      'second',
    );
    await waitUntil(
      t,
      () => ticketsIn(queue) === 3,
      'Both waiters must be in line',
      5000,
    );
    for (const caller of [holder, first, second]) {
      caller.child.kill('SIGKILL');
      await caller.closed;
    }

    // Act
    const result = await new Mutex(ticketQueue.create(directory.path)).acquire(
      'product-42',
      async () => 'got it',
      { mode: Modes.skipIfBusy() },
    );

    // Assert: nobody who is still running wants the key.
    assert.deepEqual(result, { acquired: true, value: 'got it' });
  },
);
