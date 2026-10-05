import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Mutex } from '../../mutex/mutex.ts';
import { FencedRegister } from '../../testing/fenced-register.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { graceWindow, settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { SocketStore } from './socket-store.ts';

const mutexUrl = new URL('../../mutex/mutex.ts', import.meta.url);
const socketStoreUrl = new URL('./socket-store.ts', import.meta.url);
const fencedRegisterUrl = new URL(
  '../../testing/fenced-register.ts',
  import.meta.url,
);

/**
 * A process using the socket store. It reports role changes, stays alive until
 * killed, and waits inside callbacks for `command(name)` messages from the test.
 */
const participant = (directory: string, body: string) => `
	import { appendFileSync } from 'node:fs';
	import { Mutex } from ${JSON.stringify(mutexUrl.href)};
	import { SocketStore } from ${JSON.stringify(socketStoreUrl.href)};
	import { FencedRegister } from ${JSON.stringify(fencedRegisterUrl.href)};

	const name = process.argv[1];
	const directory = ${JSON.stringify(directory)};
	const store = new SocketStore(directory, { pollInterval: 10, graceWindow: ${graceWindow} });
	store.on('role', (role) => process.send({ type: 'role', role }));
	const mutex = new Mutex(store);
	const commands = new Map();
	process.on('message', (command) => commands.get(command)?.resolve());
	const command = (name) => {
		const received = Promise.withResolvers();
		commands.set(name, received);
		return received.promise;
	};
	const journal = (line) => appendFileSync(directory + '/journal.log', name + ':' + line + '\\n');
	${body}
`;

/** Becomes the leader by being the first to need a lock, then idles. */
const leaderBody = `
	await mutex.acquire('warm-up', async () => {});
	process.send({ type: 'ready' });
`;

describe('Socket lock server failover', () => {
  test(
    'a holder keeps its key when the leader dies, and a waiter enters only after it releases',
    { timeout: 15000 },
    async (t) => {
      // Arrange: a leader, a holder inside its callback, and a waiter behind it.
      await using directory = await scratchDirectory();
      await using leader = startWorker(
        participant(directory.path, leaderBody),
        'leader',
      );
      await waitUntil(
        t,
        () => leader.has('ready'),
        `The leader must start.\n${leader.stderr}`,
        5000,
      );
      assert.equal(
        leader.find('role')?.role,
        'leader',
        'The first process to need a lock must lead',
      );

      await using holder = startWorker(
        participant(
          directory.path,
          `const outcome = await mutex.acquire('product:42', async () => {
						journal('enter');
						process.send({ type: 'entered' });
						await command('finish');
						journal('leave');
					}).then(() => 'ok', (error) => error.name);
					process.send({ type: 'done', outcome });`,
        ),
        'holder',
      );
      await waitUntil(
        t,
        () => holder.has('entered'),
        `The holder must enter.\n${holder.stderr}`,
        5000,
      );
      await using waiter = startWorker(
        participant(
          directory.path,
          `process.send({ type: 'attempted' });
					await mutex.acquire('product:42', async () => journal('enter'));
					process.send({ type: 'done' });`,
        ),
        'waiter',
      );
      await waitUntil(
        t,
        () => waiter.has('attempted'),
        `The waiter must start.\n${waiter.stderr}`,
        5000,
      );
      await delay(settle);
      const journal = async () =>
        (await readFile(join(directory.path, 'journal.log'), 'utf8'))
          .trim()
          .split('\n');

      // Act: the leader dies while the holder is inside its callback.
      leader.child.kill('SIGKILL');
      await leader.closed;
      await delay(graceWindow * 2);
      const duringFailover = await journal();
      holder.child.send('finish');

      // Assert: the holder reasserted its key, so the waiter waited for the release.
      assert.deepEqual(
        duringFailover,
        ['holder:enter'],
        'No one may enter while the holder still runs, even across a leader failover',
      );
      await waitUntil(
        t,
        () => holder.has('done') && waiter.has('done'),
        `Both must finish.\n${holder.stderr}${waiter.stderr}`,
        5000,
      );
      assert.equal(
        holder.find('done')?.outcome,
        'ok',
        'The holder must keep its lease through the failover',
      );
      assert.deepEqual(await journal(), [
        'holder:enter',
        'holder:leave',
        'waiter:enter',
      ]);
      assert.ok(
        [holder, waiter].some((worker) =>
          worker.messages.some(
            (message) => message.type === 'role' && message.role === 'leader',
          ),
        ),
        'A survivor must take over as leader',
      );
    },
  );

  test(
    'a leader that shuts down hands over without its followers losing their keys',
    { timeout: 15000 },
    async (t) => {
      // Arrange: this process leads, and a follower holds a key.
      await using directory = await scratchDirectory();
      const leaderStore = new SocketStore(directory.path, {
        pollInterval: 10,
        graceWindow,
      });
      await new Mutex(leaderStore).acquire('warm-up', async () => {});
      assert.equal(leaderStore.role, 'leader');
      await using follower = startWorker(
        participant(
          directory.path,
          `const outcome = await mutex.acquire('product:42', async () => {
						process.send({ type: 'entered' });
						await command('finish');
					}).then(() => 'ok', (error) => error.name);
					process.send({ type: 'done', outcome });`,
        ),
        'follower',
      );
      await waitUntil(
        t,
        () => follower.has('entered'),
        `The follower must enter.\n${follower.stderr}`,
        5000,
      );
      const deadline = Promise.withResolvers<'timed out'>();
      const timer = setTimeout(() => deadline.resolve('timed out'), 2000);

      try {
        // Act: the leader shuts down while the follower still holds its key.
        const shutdown = await Promise.race([
          leaderStore[Symbol.asyncDispose]().then(() => 'closed' as const),
          deadline.promise,
        ]);
        follower.child.send('finish');

        // Assert: shutdown does not wait on followers, and the holder keeps its key.
        assert.equal(
          shutdown,
          'closed',
          'A leader must shut down without waiting for followers to leave',
        );
        await waitUntil(
          t,
          () => follower.has('done'),
          `The follower must finish.\n${follower.stderr}`,
          5000,
        );
        assert.equal(
          follower.find('done')?.outcome,
          'ok',
          'A follower holding a key must keep it through the handover',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  );

  test(
    'a holder frozen past the grace window is fenced off and learns its lock was lost',
    {
      timeout: 15000,
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a fenced register, a leader, and a holder inside its callback.
      await using directory = await scratchDirectory();
      const register = new FencedRegister(join(directory.path, 'register.db'));
      const writeBody = (then: string) => `
				const outcome = await mutex.acquire('product:42', async (lease) => {
					process.send({ type: 'entered' });
					${then}
					const write = new FencedRegister(directory + '/register.db').write(lease.token);
					process.send({ type: 'wrote', write });
				}).then(() => 'ok', (error) => error.name);
				process.send({ type: 'done', outcome });
			`;
      await using leader = startWorker(
        participant(directory.path, leaderBody),
        'leader',
      );
      await waitUntil(
        t,
        () => leader.has('ready'),
        `The leader must start.\n${leader.stderr}`,
        5000,
      );
      await using frozen = startWorker(
        participant(directory.path, writeBody(`await command('write');`)),
        'frozen',
      );
      await waitUntil(
        t,
        () => frozen.has('entered'),
        `The holder must enter.\n${frozen.stderr}`,
        5000,
      );

      // Act: the holder freezes, the leader dies, and a newer holder takes the key.
      // The successor keeps leading while the frozen holder thaws.
      frozen.child.kill('SIGSTOP');
      leader.child.kill('SIGKILL');
      await leader.closed;
      await using successor = startWorker(
        participant(directory.path, writeBody('')),
        'successor',
      );
      try {
        await waitUntil(
          t,
          () => successor.has('done'),
          `The successor must get the key once the grace window passes.\n${successor.stderr}`,
          5000,
        );
        assert.equal(successor.find('wrote')?.write, 'written');
      } finally {
        frozen.child.kill('SIGCONT');
      }
      // Let the thawed holder observe the closed connection and its refused reassertion.
      await delay(graceWindow);
      frozen.child.send('write');

      // Assert: the register refused the stale holder, and the holder was told it lost the lock.
      await waitUntil(
        t,
        () => frozen.has('done'),
        `The frozen holder must finish.\n${frozen.stderr}`,
        5000,
      );
      assert.equal(
        frozen.find('wrote')?.write,
        'stale',
        'A holder superseded while frozen must be fenced off by the register',
      );
      assert.equal(
        frozen.find('done')?.outcome,
        'LockLostError',
        'A holder whose reassertion was refused must learn that it lost the lock',
      );
      assert.equal(register.writes(), 1, 'Only the newer holder may write');
    },
  );
});
