import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { describe, test } from '@zukhruf/testing/node';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { factTimeout } from '../../testing/fact-timeout.ts';
import { mutexUrl } from '../../testing/module-urls.ts';
import { settle } from '../../testing/timing.ts';
import { tokensThatFailOnce } from '../../testing/tokens-that-fail-once.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { IpcLockCoordinator } from './index.ts';

describe('Process-tree mutex with IpcStore', () => {
  test('messages of its own and unreadable lock messages from a child leave its locks working', async (t) => {
    // Arrange: the child sends its parent its own messages, and lock envelopes that hold no request.
    const coordinator = new IpcLockCoordinator();
    const mutex = new Mutex(coordinator);
    const ipcStoreUrl = new URL('./ipc-store.ts', import.meta.url);
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
      { admit: (child) => coordinator.adopt(child) },
    );

    // Act
    await t.waitFor(
      () =>
        assert.ok(
          child.has('released'),
          `The child must take and release the key after its other messages.\n${child.stderr}`,
        ),
      { interval: 5, timeout: factTimeout },
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
  });

  test(
    'a child waiting for a key learns that no coordinator is left when its parent dies',
    {
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
        './ipc-lock-coordinator.ts',
        import.meta.url,
      );
      const ipcStoreUrl = new URL('./ipc-store.ts', import.meta.url);
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
          { interval: 10, timeout: factTimeout },
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
        { interval: 10, timeout: factTimeout },
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
      const ipcUrl = new URL('./index.ts', import.meta.url);
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
          { interval: 10, timeout: factTimeout },
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

describe('A worker or child whose token cannot be minted', () => {
  test('a child learns that its try failed, takes another key, and that key is free once the child exits', async (t) => {
    // Arrange: the parent's token source fails for the first grant.
    const coordinator = new IpcLockCoordinator({
      tokens: tokensThatFailOnce(
        new Error('The token file could not be written.'),
      ),
    });
    const mutex = new Mutex(coordinator);
    const ipcStoreUrl = new URL('./ipc-store.ts', import.meta.url);
    const modesUrl = new URL(
      '../../mutex/acquire-modes/modes.ts',
      import.meta.url,
    );
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
      { admit: (child) => coordinator.adopt(child) },
    );

    // Act: the child reports while it holds the second key, and then exits.
    await t.waitFor(
      () =>
        assert.ok(
          child.has('holding'),
          `The child must report while it holds a key.\n${child.stderr}`,
        ),
      { interval: 5, timeout: factTimeout },
    );
    child.child.kill('SIGKILL');
    await child.closed;
    const next = await mutex.acquire(
      'product:43',
      async () => 'granted' as const,
      {
        mode: Modes.skipIfBusy({ waitAtMost: factTimeout, clock: globalThis }),
      },
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
  });
});
