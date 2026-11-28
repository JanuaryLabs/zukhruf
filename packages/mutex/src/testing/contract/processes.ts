import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { describe, test } from '@zukhruf/parameterized-test';
import { NodeCommand } from '@zukhruf/process';
import { waitFor } from '@zukhruf/testing/async';

import { Mutex } from '../../mutex/mutex.ts';
import { hold } from '../hold.ts';
import { modesUrl, mutexUrl } from '../module-urls.ts';
import { settle } from '../timing.ts';
import { watch } from '../watch.ts';
import { label, longKey } from './keys.ts';
import { childPrelude, holderSource, storeIn } from './peers.ts';
import type { Host, SharedByProcesses, Subject } from './subject.ts';
import { windowFor } from './window.ts';

/** A child or thread that skips, then cancels a wait, while its host holds the key, and reports each result. */
export const skipperBody = `
	const atOnce = await mutex.acquire('report:daily', async () => 'ran', { mode: Modes.skipIfBusy() });
	const afterLimit = await mutex.acquire('report:daily', async () => 'ran', { mode: Modes.skipIfBusy({ waitAtMost: 100, clock: globalThis }) });
	const cancel = new AbortController();
	setTimeout(() => cancel.abort(new Error('cancelled')), 50);
	const cancelled = await mutex.acquire('report:daily', async () => 'ran', { signal: cancel.signal }).catch((error) => error.message);
	report({ type: 'results', atOnce, afterLimit, cancelled });
`;

/** A store whose child processes share its locks. */
export function processes<H extends Host>(
  store: Subject<H>,
  sharing: SharedByProcesses<H>,
): void {
  describe(`Holder check across processes with ${store.name}`, () => {
    test('a look sees a holder in another process, and no holder once that process is killed', async (t) => {
      // Arrange: another process holds the key and never lets it go.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      // The holder process must enter its task.
      await using holder = await new NodeCommand(
        holderSource(sharing.module, fixture.location),
        { name: 'holder', env: process.env, clock: globalThis },
      ).start({
        ready: { message: 'entered' },
        admit: (child) => sharing.admit(host, child),
        signal: t.signal,
      });
      const mutex = new Mutex(host.store);

      // Act
      const whileAlive = await mutex.isHeld('report:daily');
      holder.process.signal('SIGKILL');
      await holder.process.ended;

      // Assert: the store sees the end of the holder some time after its process closed.
      assert.equal(whileAlive, true);
      await waitFor(
        async () => assert.equal(await mutex.isHeld('report:daily'), false),
        { signal: t.signal },
      );
    });

    test('after a killed holder, the next holder reads as held, and nobody once it ends', async (t) => {
      // Arrange: a holder process dies while it holds the key.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      // The holder process must enter its task.
      await using holder = await new NodeCommand(
        holderSource(sharing.module, fixture.location),
        { name: 'holder', env: process.env, clock: globalThis },
      ).start({
        ready: { message: 'entered' },
        admit: (child) => sharing.admit(host, child),
        signal: t.signal,
      });
      holder.process.signal('SIGKILL');
      await holder.process.ended;
      const mutex = new Mutex(host.store);

      // Act
      const during = await mutex.acquire('report:daily', () =>
        mutex.isHeld('report:daily'),
      );
      const after = await mutex.isHeld('report:daily');

      // Assert
      assert.deepEqual({ during, after }, { during: true, after: false });
    });

    test('a look from a child process sees a holder in this process', async (t) => {
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
        // The child must report its look.
        await using looker = await new NodeCommand(
          `
							${childPrelude(sharing.module, fixture.location)}
							process.send({ type: 'looked', held: await mutex.isHeld('report:daily') });
						`,
          { name: 'looker', env: process.env, clock: globalThis },
        ).start({
          ready: { message: 'looked' },
          admit: (child) => sharing.admit(host, child),
          signal: t.signal,
        });

        // Assert
        assert.equal(
          looker.messages.find((message) => message.type === 'looked')?.held,
          true,
        );
      } finally {
        release.resolve();
        await holding;
      }
    });
  });
  describe(`Cross-process mutex with ${store.name}`, () => {
    const workerPrelude = (location: string) => `
			import { Mutex } from ${JSON.stringify(mutexUrl.href)};

			const name = process.argv[1];
			const mutex = new Mutex(${storeIn(sharing.module, location)});
		`;

    void test.each(['product:42', longKey], (key) =>
      test(`two Node processes using resource name ${label(key)} take turns and both finish`, async (t) => {
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
						if (command.type === 'finish') {
							finish.resolve();
							return;
						}
						if (command.type !== 'start') return;
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

        const start = (name: string) =>
          new NodeCommand(workerSource, {
            name,
            env: process.env,
            clock: globalThis,
          }).start({
            ready: { message: 'ready' },
            admit: (child) => sharing.admit(host, child),
            signal: t.signal,
          });
        // Both Node processes must be ready before the contention scenario starts.
        await using first = await start('first');
        await using second = await start('second');
        const stderr = () =>
          first.process.stderrTail() + second.process.stderrTail();

        // Act: first holds the key while second attempts to acquire that same key.
        first.send({ type: 'start' });
        // The first acquire of a new process also opens the store.
        // The first process must enter its callback.
        await first.next('entered', { signal: t.signal });
        second.send({ type: 'start' });
        // The second process must attempt the same resource key.
        await second.next('attempted', { signal: t.signal });
        // Both workers are already running. Keep the first callback open briefly
        // so an unprotected second callback has an opportunity to overlap it.
        await delay(windowFor(store, 100), undefined, { signal: t.signal });
        first.send({ type: 'finish' });
        // After the first operation finishes, the second process must enter its callback.
        await Promise.all([
          first.next('completed', { signal: t.signal }),
          second.next('entered', { signal: t.signal }),
        ]);
        second.send({ type: 'finish' });
        // Both processes must finish their operations and exit.
        const ends = await untilAborted(
          Promise.all([first.process.ended, second.process.ended]),
          t.signal,
        );

        // Assert: both callers finish, and the actual callback intervals never overlap.
        assert.deepEqual(
          ends,
          [{ exitCode: 0 }, { exitCode: 0 }],
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
      }),
    );

    void test.each(['product:42', longKey], (key) =>
      test(`a holder process killed while holding resource name ${label(key)} does not block the next caller`, async (t) => {
        // Arrange: another process enters the callback and never leaves it.
        await using fixture = await store.fixture(process.env);
        await using host = store.open(fixture.location);
        // The holder process must enter its callback.
        await using holder = await new NodeCommand(
          `
						${workerPrelude(fixture.location)}
						setInterval(() => {}, 1000);
						await mutex.acquire(${JSON.stringify(key)}, async () => {
							process.send({ type: 'entered' });
							await new Promise(() => {});
						});
					`,
          { name: 'holder', env: process.env, clock: globalThis },
        ).start({
          ready: { message: 'entered' },
          admit: (child) => sharing.admit(host, child),
          signal: t.signal,
        });
        const mutex = new Mutex(host.store);

        // Act: the holder dies without releasing, then this process asks for the same key.
        holder.process.signal('SIGKILL');
        await holder.process.ended;
        const acquired = await mutex.acquire(key, async () => true, {
          signal: t.signal,
        });

        // Assert: the dead holder's lock is recovered instead of blocking forever.
        assert.equal(acquired, true);
      }),
    );

    test('four processes incrementing a shared counter never lose an update', async (t) => {
      // Arrange: each increment reads, yields, then writes, so any overlap loses an update.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      await using journals = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const counter = join(journals.path, 'counter');
      const tokenJournal = join(journals.path, 'tokens.log');
      await writeFile(counter, '0');
      // 25 rounds for each process, or as many as about 2 s of grants at the
      // store's usual grant time and never fewer than 6, so a store whose
      // grant is slow (a container for each claim) still hands the key over 24
      // times. The processes start their rounds together, after each took a
      // grant: with no exclusion, their first rounds overlap, however few
      // rounds there are.
      const increments = Math.min(
        25,
        Math.max(6, Math.round(2_000 / store.grantLatency)),
      );
      const source = `
					import { appendFile, readFile, writeFile } from 'node:fs/promises';
					import { setImmediate as nextTurn } from 'node:timers/promises';
					${workerPrelude(fixture.location)}
					const counter = ${JSON.stringify(counter)};

					await mutex.acquire('warm-up', async () => {});
					process.send({ type: 'ready' });
					await new Promise((go) => process.once('message', go));
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
      const processes = await Promise.all(
        ['a', 'b', 'c', 'd'].map(async (name) =>
          workers.use(
            await new NodeCommand(source, {
              name,
              env: process.env,
              clock: globalThis,
            }).start({
              ready: { message: 'ready' },
              admit: (child) => sharing.admit(host, child),
              signal: t.signal,
            }),
          ),
        ),
      );
      for (const worker of processes) worker.send({ type: 'go' });
      const ends = await Promise.all(
        processes.map((worker) => worker.process.ended),
      );

      // Assert: every increment ran exclusively, so none was overwritten.
      assert.deepEqual(
        ends,
        processes.map(() => ({ exitCode: 0 })),
        `Every worker process must exit successfully.\n${processes.map((worker) => worker.process.stderrTail()).join('')}`,
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
    });

    test(
      'a waiter keeps waiting while the holder is frozen, and gets the key once it resumes and releases',
      {
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
						if (command.type === 'release') release.resolve();
					});
					await mutex.acquire('product:42', async () => {
						process.send({ type: 'holding' });
						await release.promise;
					});
					process.send({ type: 'released' });
				`;
        // The holder must take the key
        await using holder = await new NodeCommand(holderSource, {
          name: 'holder',
          env: process.env,
          clock: globalThis,
        }).start({
          ready: { message: 'holding' },
          admit: (child) => sharing.admit(host, child),
          signal: t.signal,
        });

        // Act: the holder freezes, and this process waits for the key.
        holder.process.signal('SIGSTOP');
        const acquire = mutex.acquire(
          'product:42',
          async (lease) => lease.token,
        );
        const waiter = watch(acquire);
        await delay(windowFor(store, settle * 10));
        const whileFrozen = waiter.now.status;
        holder.process.signal('SIGCONT');
        holder.send({ type: 'release' });

        // Assert: a frozen holder can resume at any time, so its key stays its own.
        assert.equal(
          whileFrozen,
          'pending',
          'A waiter took the key of a frozen holder, which can still resume and write',
        );
        // The waiter must get the key once the holder releases it.
        await untilAborted(acquire, t.signal);
      },
    );
  });
  describe(`Acquire modes across processes with ${store.name}`, () => {
    test('a process that skips or cancels while another process holds gets no key, and leaves the key free', async (t) => {
      // Arrange: this process holds the key; a child (kept alive) tries to skip.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');
      // The child must report.
      await using child = await new NodeCommand(
        `
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { Modes } from ${JSON.stringify(modesUrl.href)};
					setInterval(() => {}, 1000);
					const mutex = new Mutex(${storeIn(sharing.module, fixture.location)});
					const report = (message) => process.send(message);
					${skipperBody}
				`,
        { name: 'skipper', env: process.env, clock: globalThis },
      ).start({
        ready: { message: 'results' },
        admit: (child) => sharing.admit(host, child),
        signal: t.signal,
      });

      // Act
      await holder.release();

      // Assert: both skips gave up, the wait was cancelled, and no grant was left with the child.
      const results = child.messages.find(
        (message) => message.type === 'results',
      );
      assert.deepEqual(
        {
          atOnce: results?.atOnce,
          afterLimit: results?.afterLimit,
          cancelled: results?.cancelled,
        },
        {
          atOnce: { acquired: false },
          afterLimit: { acquired: false },
          cancelled: 'cancelled',
        },
      );
      assert.equal(
        await mutex.acquire('report:daily', async () => 'next'),
        'next',
        'The key must be free after the holder releases it; the child that gave up must not keep it',
      );
    });
  });
}
