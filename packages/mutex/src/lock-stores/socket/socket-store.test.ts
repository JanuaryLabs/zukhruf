import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { LeaderElection } from '../../leader-election/leader-election.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { FencedRegister } from '../../testing/fenced-register.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { graceWindow, settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { watch } from '../../testing/watch.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { type SocketRole, SocketStore } from './socket-store.ts';

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
      const leaderRoles: SocketRole[] = [];
      leaderStore.on('role', (role) => leaderRoles.push(role));
      await new Mutex(leaderStore).acquire('warm-up', async () => {});
      assert.deepEqual(leaderRoles, ['leader']);
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

describe('Socket store disposal', () => {
  test('a store disposed while it becomes the leader leaves no lock server and no term behind', async () => {
    // Arrange: the first acquire in a directory makes the store campaign.
    await using directory = await scratchDirectory();
    const store = new SocketStore(directory.path, { pollInterval: 10 });
    const roles: SocketRole[] = [];
    store.on('role', (role) => roles.push(role));
    const acquiring = watch(store.acquire('product:42'));

    // Act
    await store[Symbol.asyncDispose]();
    await delay(settle);

    // Assert
    await using leadership = await new LeaderElection(directory.path, {
      pollInterval: 10,
    }).campaign();
    assert.ok(leadership, 'A disposed store must not keep a leadership term');
    assert.deepEqual(roles, [], 'A disposed store must not start serving');
    assert.equal(
      acquiring.now.status,
      'rejected',
      'The acquire must fail with its disposed store',
    );
  });
});

describe('Socket store lock server failure', () => {
  test(
    'a leader whose lock server cannot start reports why and ends its term',
    {
      skip:
        process.platform === 'win32'
          ? 'A named pipe has no file that a directory can block'
          : false,
    },
    async () => {
      // Arrange: a directory where the socket file must go makes the lock server fail to start.
      await using directory = await scratchDirectory();
      const socketPath = join(directory.path, 'lock.sock');
      await mkdir(socketPath);
      await using store = new SocketStore(directory.path, { pollInterval: 10 });

      // Act
      const failure = await store.acquire('product:42').then(
        () => undefined,
        (error: unknown) => error,
      );

      // Assert
      assert.ok(
        failure instanceof Error &&
          'path' in failure &&
          failure.path === socketPath,
        `The acquire must fail with the lock server's own start error, got ${String(failure)}`,
      );
      await using leadership = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      assert.ok(
        leadership,
        'A leader whose lock server failed to start must end its term',
      );
    },
  );

  test('a leader whose role listener throws closes its lock server before ending its term', async () => {
    // Arrange: the first acquire in the directory makes this store the leader.
    await using directory = await scratchDirectory();
    await using store = new SocketStore(directory.path, { pollInterval: 10 });
    const listenerFailure = new Error('The role listener failed');
    store.once('role', () => {
      throw listenerFailure;
    });

    // Act
    const failure = await store.acquire('product:42').then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert: no lock server may outlive its term, or a second leader could grant the same keys.
    assert.equal(failure, listenerFailure);
    const otherLeader = new SocketStore(directory.path, { pollInterval: 10 });
    const roles: SocketRole[] = [];
    otherLeader.on('role', (role) => roles.push(role));
    try {
      const lease = await otherLeader.acquire('product:42');
      await lease[Symbol.asyncDispose]();
      assert.deepEqual(
        roles,
        ['leader'],
        'Another store must lead, not follow a lock server whose term ended',
      );
    } finally {
      await otherLeader[Symbol.asyncDispose]();
    }
  });
});

describe('Socket store roles', () => {
  test('a store that becomes the leader reports only the leader role', async () => {
    // Arrange
    await using directory = await scratchDirectory();
    await using store = new SocketStore(directory.path, { pollInterval: 10 });
    const roles: SocketRole[] = [];
    store.on('role', (role) => roles.push(role));

    // Act: the first acquire in the directory wins the election.
    const lease = await store.acquire('product:42');
    await lease[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(
      roles,
      ['leader'],
      'A leader must not report itself as a follower',
    );
  });

  test('a store that reaches another leader reports only the follower role', async () => {
    // Arrange: one store leads the directory.
    await using directory = await scratchDirectory();
    await using leader = new SocketStore(directory.path, { pollInterval: 10 });
    await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
    await using follower = new SocketStore(directory.path, {
      pollInterval: 10,
    });
    const roles: SocketRole[] = [];
    follower.on('role', (role) => roles.push(role));

    // Act
    const lease = await follower.acquire('product:42');
    await lease[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(roles, ['follower']);
  });

  test('a follower reports the follower role again when it reaches a new leader', async (t) => {
    // Arrange: one store leads, and two stores follow it.
    await using directory = await scratchDirectory();
    const options = { pollInterval: 10, graceWindow: 50 };
    const leader = new SocketStore(directory.path, options);
    await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
    await using first = new SocketStore(directory.path, options);
    await using second = new SocketStore(directory.path, options);
    const roles = new Map<SocketStore, SocketRole[]>([
      [first, []],
      [second, []],
    ]);
    for (const [store, seen] of roles) {
      store.on('role', (role) => seen.push(role));
      await (await store.acquire('warm-up'))[Symbol.asyncDispose]();
    }

    // Act: the leader stops, and one follower takes over.
    await leader[Symbol.asyncDispose]();
    await waitUntil(
      t,
      () => [...roles.values()].some((seen) => seen.includes('leader')),
      'A follower must take over as leader',
    );
    const stayed = [...roles.values()].find((seen) => !seen.includes('leader'));
    await waitUntil(
      t,
      () => stayed?.length === 2,
      'The other follower must follow the new leader',
    );

    // Assert
    assert.deepEqual(stayed, ['follower', 'follower']);
  });
});

describe('Socket store follower failure', () => {
  test(
    'a follower whose role listener throws gives up that acquire and leaves nothing open',
    { timeout: 10_000 },
    async (t) => {
      // Arrange: a leader serves the directory from this process.
      await using directory = await scratchDirectory();
      await using leader = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();

      // Act: a follower process whose role listener throws once acquires twice, then just ends.
      await using follower = startWorker(
        `
				import { Mutex } from ${JSON.stringify(mutexUrl.href)};
				import { SocketStore } from ${JSON.stringify(socketStoreUrl.href)};

				const store = new SocketStore(${JSON.stringify(directory.path)}, { pollInterval: 10 });
				const mutex = new Mutex(store);
				store.once('role', () => {
					throw new Error('The role listener failed');
				});
				const outcome = (acquiring) =>
					acquiring.then(() => 'granted', (error) => error.message);
				process.send({ type: 'first', outcome: await outcome(mutex.acquire('product:42', async () => {})) });
				process.send({ type: 'second', outcome: await outcome(mutex.acquire('product:42', async () => {})) });
			`,
        'follower',
      );
      await waitUntil(
        t,
        () => follower.exit !== null,
        `The follower must end on its own once its work is done.\n${follower.stderr}`,
        5000,
      );

      // Assert: the failed acquire reported the listener's error, the next one worked, and nothing kept the process alive.
      assert.equal(follower.find('first')?.outcome, 'The role listener failed');
      assert.equal(follower.find('second')?.outcome, 'granted');
      assert.deepEqual(
        follower.exit,
        { code: 0, signal: null },
        follower.stderr,
      );
    },
  );

  test(
    'a follower whose role listener throws closes its connection to the leader',
    {
      skip:
        process.platform === 'win32'
          ? 'The stand-in leader listens on the Unix socket path'
          : false,
    },
    async (t) => {
      // Arrange: a stand-in leader holds the term and serves the socket path; it records when its peer goes away.
      await using directory = await scratchDirectory();
      await using _term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      let peerClosed = false;
      const leader = createServer((peer) => {
        peer.once('close', () => (peerClosed = true));
        // It speaks this protocol, so the follower gets as far as reporting its role.
        peer.once('data', () =>
          peer.write(`${JSON.stringify({ op: 'welcome' })}\n`),
        );
      });
      leader.listen(join(directory.path, 'lock.sock'));
      await once(leader, 'listening');
      await using store = new SocketStore(directory.path, { pollInterval: 10 });
      store.once('role', () => {
        throw new Error('The role listener failed');
      });

      try {
        // Act
        await assert.rejects(store.acquire('product:42'), {
          message: 'The role listener failed',
        });

        // Assert: nothing keeps the connection open after the follower gave it up.
        await waitUntil(
          t,
          () => peerClosed,
          'The follower must close the connection it gave up',
        );
      } finally {
        leader.close();
      }
    },
  );
});
