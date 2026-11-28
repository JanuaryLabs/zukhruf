import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Latch, untilAborted } from '@zukhruf/async';
import { FileLock, Presence, TemporaryFiles, isErrno } from '@zukhruf/fs';
import { type Message, NodeCommand } from '@zukhruf/process';
import { waitFor } from '@zukhruf/testing/async';

import { Mutex } from '../../mutex/mutex.ts';
import { isRecord } from '../../shared/is-record.ts';
import { FencedRegister } from '../../testing/fenced-register.ts';
import { grantedWithin } from '../../testing/granted-within.ts';
import { linesOf } from '../../testing/lines-of.ts';
import { modesUrl, mutexUrl } from '../../testing/module-urls.ts';
import { onUnixSockets } from '../../testing/on-unix-sockets.ts';
import { standInServer } from '../../testing/stand-in-server.ts';
import { succeedLastLeader } from '../../testing/succeed-last-leader.ts';
import { pollInterval, settle } from '../../testing/timing.ts';
import { watch } from '../../testing/watch.ts';
import { socketElection } from './socket-election.ts';
import {
  type SocketRole,
  SocketStore,
  type SocketStoreOptions,
} from './socket-store.ts';

const socketStoreUrl = new URL('./socket-store.ts', import.meta.url);
const socketElectionUrl = new URL('./socket-election.ts', import.meta.url);
const fakeTimersUrl = import.meta.resolve('@sinonjs/fake-timers');
const fencedRegisterUrl = new URL(
  '../../testing/fenced-register.ts',
  import.meta.url,
);

/**
 * A process using the socket store. It reports role changes, stays alive until
 * killed, and waits inside callbacks for `command(name)` messages from the test.
 * `options` are added to the options of its store.
 */
const participant = (
  directory: string,
  body: string,
  options: Pick<SocketStoreOptions, 'leaseDuration'> = {},
) => `
	import { appendFileSync } from 'node:fs';
	import { Mutex } from ${JSON.stringify(mutexUrl.href)};
	import { Modes } from ${JSON.stringify(modesUrl.href)};
	import { SocketStore } from ${JSON.stringify(socketStoreUrl.href)};
	import { FencedRegister } from ${JSON.stringify(fencedRegisterUrl.href)};

	const name = process.argv[1];
	const directory = ${JSON.stringify(directory)};
	const store = new SocketStore(directory, { clock: globalThis, ...${JSON.stringify(options)} });
	store.on('role', (role) => process.send({ type: 'role', role }));
	const mutex = new Mutex(store);
	const commands = new Map();
	process.on('message', (command) => commands.get(command.type)?.resolve());
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

/**
 * Waits for the key that the holder has, and on `check` asks the leader
 * whether the key is held and tries it once. A new leader answers the look
 * only after its recovery, so the answers come after the holder reasserted
 * its key or lost it: no wait on the time is needed.
 */
const waiterBody = `
	process.send({ type: 'attempted' });
	const entering = mutex.acquire('product:42', async () => journal('enter'));
	await command('check');
	const held = await store.isHeld('product:42');
	const tried = await mutex.acquire('product:42', async () => journal('tried'), { mode: Modes.skipIfBusy() });
	process.send({ type: 'checked', held, acquired: tried.acquired });
	await entering;
	process.send({ type: 'done' });
`;

/** Holds `product:42` inside its callback until `finish`, and reports how the call ended. */
const holderBody = `
	const outcome = await mutex.acquire('product:42', async () => {
		journal('enter');
		process.send({ type: 'entered' });
		await command('finish');
		journal('leave');
	}).then(() => 'ok', (error) => error.name);
	process.send({ type: 'done', outcome });
`;

describe('Socket lock server failover', () => {
  test('a holder keeps its key when the leader dies, and a waiter enters only after it releases', async (t) => {
    // Arrange: a leader, a holder inside its callback, and a waiter behind it.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using _successor = succeedLastLeader(directory.path);
    // The leader must start.
    await using leader = await new NodeCommand(
      participant(directory.path, leaderBody),
      { name: 'leader', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'ready' }, signal: t.signal });
    assert.equal(
      leader.messages.find((message) => message.type === 'role')?.role,
      'leader',
      'The first process to need a lock must lead',
    );

    // The holder must enter.
    await using holder = await new NodeCommand(
      participant(directory.path, holderBody),
      { name: 'holder', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'entered' }, signal: t.signal });
    // The waiter must start.
    await using waiter = await new NodeCommand(
      participant(directory.path, waiterBody),
      { name: 'waiter', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'attempted' }, signal: t.signal });
    const journal = async () =>
      (await readFile(join(directory.path, 'journal.log'), 'utf8'))
        .trim()
        .split('\n');

    // Act: the leader dies while the holder is inside its callback.
    leader.process.signal('SIGKILL');
    await leader.process.ended;
    waiter.send({ type: 'check' });
    // The waiter must hear from the next leader, after its recovery.
    await waiter.next('checked', { signal: t.signal });
    const duringFailover = await journal();
    holder.send({ type: 'finish' });

    // Assert: the holder reasserted its key, so the waiter waited for the release.
    assert.deepEqual(
      {
        held: waiter.messages.find((message) => message.type === 'checked')
          ?.held,
        acquired: waiter.messages.find((message) => message.type === 'checked')
          ?.acquired,
      },
      { held: true, acquired: false },
      'The next leader must see the key of the holder, and refuse a try of it',
    );
    assert.deepEqual(
      duringFailover,
      ['holder:enter'],
      'No one may enter while the holder still runs, even across a leader failover',
    );
    // Both must finish.
    await Promise.all([
      holder.next('done', { signal: t.signal }),
      waiter.next('done', { signal: t.signal }),
    ]);
    assert.equal(
      holder.messages.find((message) => message.type === 'done')?.outcome,
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
  });

  test('a leader that shuts down hands over without its followers losing their keys', async (t) => {
    // Arrange: this process leads, and a follower holds a key.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const leaderStore = new SocketStore(directory.path, {
      clock: globalThis,
    });
    const leaderRoles: SocketRole[] = [];
    leaderStore.on('role', (role) => leaderRoles.push(role));
    await new Mutex(leaderStore).acquire('warm-up', async () => {});
    assert.deepEqual(leaderRoles, ['leader']);
    // The follower must enter.
    await using follower = await new NodeCommand(
      participant(
        directory.path,
        `const outcome = await mutex.acquire('product:42', async () => {
						process.send({ type: 'entered' });
						await command('finish');
					}).then(() => 'ok', (error) => error.name);
					process.send({ type: 'done', outcome });`,
      ),
      { name: 'follower', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'entered' }, signal: t.signal });

    // Act: the leader shuts down while the follower still holds its key.
    await leaderStore[Symbol.asyncDispose]();
    follower.send({ type: 'finish' });

    // Assert: shutdown did not wait on followers, and the holder keeps its key.
    // The follower must finish.
    await follower.next('done', { signal: t.signal });
    assert.equal(
      follower.messages.find((message) => message.type === 'done')?.outcome,
      'ok',
      'A follower holding a key must keep it through the handover',
    );
  });

  test('a leader that shuts down while a follower holds a key still lets a waiter enter only after the holder releases', async (t) => {
    // Arrange: a leader, a holder inside its callback, and a waiter behind it.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using _successor = succeedLastLeader(directory.path);
    // The leader must start.
    await using leader = await new NodeCommand(
      participant(
        directory.path,
        `${leaderBody}
					await command('dispose');
					await store[Symbol.asyncDispose]();
					process.send({ type: 'disposed' });`,
      ),
      { name: 'leader', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'ready' }, signal: t.signal });
    // The holder must enter.
    await using holder = await new NodeCommand(
      participant(directory.path, holderBody),
      { name: 'holder', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'entered' }, signal: t.signal });
    // The waiter must reach the leader.
    await using waiter = await new NodeCommand(
      participant(directory.path, waiterBody),
      { name: 'waiter', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'role' }, signal: t.signal });
    const journal = async () =>
      (await readFile(join(directory.path, 'journal.log'), 'utf8'))
        .trim()
        .split('\n');
    /** Selects the second role message a worker sends. */
    const secondRole = () => {
      let roles = 0;
      return ({ type }: Message) => type === 'role' && ++roles === 2;
    };

    // Act: the leader shuts down while the holder is inside its callback.
    leader.send({ type: 'dispose' });
    // The leader must shut down.
    await leader.next('disposed', { signal: t.signal });
    // The holder and the waiter must reach the next leader.
    await Promise.all([
      holder.next(secondRole(), { signal: t.signal }),
      waiter.next(secondRole(), { signal: t.signal }),
    ]);
    waiter.send({ type: 'check' });
    // The waiter must hear from the next leader, after its recovery.
    await waiter.next('checked', { signal: t.signal });
    const duringFailover = await journal();
    holder.send({ type: 'finish' });

    // Assert: the holder reasserted its key, so the waiter waited for the release.
    assert.deepEqual(
      {
        held: waiter.messages.find((message) => message.type === 'checked')
          ?.held,
        acquired: waiter.messages.find((message) => message.type === 'checked')
          ?.acquired,
      },
      { held: true, acquired: false },
      'The next leader must see the key of the holder, and refuse a try of it',
    );
    assert.deepEqual(
      duringFailover,
      ['holder:enter'],
      'No one may enter while the holder still runs, even when the leader shuts down',
    );
    // Both must finish.
    await Promise.all([
      holder.next('done', { signal: t.signal }),
      waiter.next('done', { signal: t.signal }),
    ]);
    assert.equal(
      holder.messages.find((message) => message.type === 'done')?.outcome,
      'ok',
      'The holder must keep its lease through the failover',
    );
    assert.deepEqual(await journal(), [
      'holder:enter',
      'holder:leave',
      'waiter:enter',
    ]);
  });

  test(
    'a holder frozen past its lease duration is fenced off and learns its lock was lost',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a fenced register, a leader, and a holder inside its callback.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _successor = succeedLastLeader(directory.path);
      const register = new FencedRegister(join(directory.path, 'register.db'));
      const writeBody = (then: string) => `
				const outcome = await mutex.acquire('product:42', async (lease) => {
					process.send({ type: 'entered' });
					${then}
					const told = lease.signal.aborted;
					const write = new FencedRegister(directory + '/register.db').write(lease.token);
					process.send({ type: 'wrote', write, told });
				}).then(() => 'ok', (error) => error.name);
				process.send({ type: 'done', outcome });
			`;
      // The leader must start.
      await using leader = await new NodeCommand(
        participant(directory.path, leaderBody),
        { name: 'leader', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      // After it thaws, the holder waits until it learns that its lease was lost, and then writes.
      // The holder must enter.
      await using frozen = await new NodeCommand(
        participant(
          directory.path,
          writeBody(
            `await command('write'); if (!lease.signal.aborted) await new Promise((resolve) => lease.signal.addEventListener('abort', resolve, { once: true }));`,
          ),
          { leaseDuration: 500 },
        ),
        { name: 'frozen', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'entered' }, signal: t.signal });

      // Act: the holder freezes, the leader dies, and a newer holder takes the key.
      // The successor keeps leading while the frozen holder thaws.
      frozen.process.signal('SIGSTOP');
      leader.process.signal('SIGKILL');
      await leader.process.ended;
      await using successor = await new NodeCommand(
        participant(directory.path, writeBody('')),
        { name: 'successor', env: process.env, clock: globalThis },
      ).start({ signal: t.signal });
      try {
        // The successor must get the key once the lease duration of the frozen holder passes.
        await successor.next('done', { signal: t.signal });
        assert.equal(
          successor.messages.find((message) => message.type === 'wrote')?.write,
          'written',
        );
      } finally {
        frozen.process.signal('SIGCONT');
      }
      frozen.send({ type: 'write' });

      // Assert: the register refused the stale holder, and the holder was told it lost the lock.
      // The frozen holder must finish.
      await frozen.next('done', { signal: t.signal });
      assert.equal(
        frozen.messages.find((message) => message.type === 'wrote')?.told,
        true,
        'The thawed holder must be told it lost the key before it writes',
      );
      assert.equal(
        frozen.messages.find((message) => message.type === 'wrote')?.write,
        'stale',
        'A holder superseded while frozen must be fenced off by the register',
      );
      assert.equal(
        frozen.messages.find((message) => message.type === 'done')?.outcome,
        'LeaseLostError',
        'A holder whose reassertion was refused must learn that it lost the lock',
      );
      assert.equal(register.writes(), 1, 'Only the newer holder may write');
    },
  );

  // The lease, 1500 ms, outlasts the longest step of the back-off, about
  // 1200 ms, so only a watch that lasts across the steps reaches its end.
  test(
    'a process ends a leader that froze before its lock server listened, and leads',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a process wins the term with a short lease and freezes
      // before it serves.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      // The leader must win the term.
      await using leader = await new NodeCommand(
        `import { socketElection } from ${JSON.stringify(socketElectionUrl.href)};
				const term = await socketElection(${JSON.stringify(directory.path)}, globalThis, 1500).campaign();
				// A listener keeps the channel to the test, and so this process, alive.
				process.on('message', () => {});
				process.send({ type: term ? 'leading' : 'lost' });`,
        { name: 'leader', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'leading' }, signal: t.signal });
      leader.process.signal('SIGSTOP');
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
      });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));

      // Act
      const entered = await new Mutex(store).acquire(
        'product:42',
        async () => 'entered',
        { signal: t.signal },
      );

      // Assert
      assert.equal(entered, 'entered');
      const end = await untilAborted(leader.process.ended, t.signal);
      assert.equal(
        end.signal,
        'SIGKILL',
        `The process must end the frozen leader.\n${leader.process.stderrTail()}`,
      );
      assert.deepEqual(roles, ['leader']);
    },
  );

  // The leader's short lease duration, not the default of 15 s, must reach
  // the followers through its store.
  test(
    'a leader frozen past its lease duration is ended by a follower, a survivor leads, and the holder keeps its key',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a leader with a short lease, a holder inside its callback,
      // and this process as a follower.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _successor = succeedLastLeader(directory.path);
      // The leader must start.
      await using leader = await new NodeCommand(
        participant(directory.path, leaderBody, { leaseDuration: 500 }),
        { name: 'leader', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      // The holder must enter.
      await using holder = await new NodeCommand(
        participant(
          directory.path,
          `const outcome = await mutex.acquire('product:42', async () => {
						process.send({ type: 'entered' });
						await command('finish');
					}).then(() => 'ok', (error) => error.name);
					process.send({ type: 'done', outcome });`,
        ),
        { name: 'holder', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'entered' }, signal: t.signal });
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
      });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));
      assert.equal(await store.isHeld('product:42'), true);
      assert.deepEqual(roles, ['follower']);

      // Act: the leader freezes.
      leader.process.signal('SIGSTOP');

      // Assert: a follower ended it, the holder reasserted its key on the
      // successor, and the successor grants the key after the release.
      const end = await untilAborted(leader.process.ended, t.signal);
      assert.equal(
        end.signal,
        'SIGKILL',
        `A follower must end the frozen leader.\n${leader.process.stderrTail()}`,
      );
      assert.equal(
        await store.isHeld('product:42'),
        true,
        'The holder must reassert its key on the successor',
      );
      holder.send({ type: 'finish' });
      // The holder must finish.
      await holder.next('done', { signal: t.signal });
      assert.equal(
        holder.messages.find((message) => message.type === 'done')?.outcome,
        'ok',
        'The holder must keep its lease through the end of the frozen leader',
      );
      assert.equal(
        await new Mutex(store).acquire('product:42', async () => 'entered'),
        'entered',
      );
    },
  );
});

describe('Socket store disposal', () => {
  test('a store disposed while it becomes the leader leaves no lock server and no term behind', async () => {
    // Arrange: the first acquire in a directory makes the store campaign.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const store = new SocketStore(directory.path, {
      clock: globalThis,
    });
    const roles: SocketRole[] = [];
    store.on('role', (role) => roles.push(role));
    const acquiring = watch(store.acquire('product:42'));

    // Act
    await store[Symbol.asyncDispose]();
    await delay(settle);

    // Assert
    await using term = await socketElection(
      directory.path,
      globalThis,
    ).campaign();
    assert.ok(term, 'A disposed store must not keep a leadership term');
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
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      const socketPath = join(directory.path, 'lock.sock');
      await mkdir(socketPath);
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
      });

      // Act
      const failure = await store.acquire('product:42').then(
        () => undefined,
        (error: unknown) => error,
      );

      // Assert
      assert.ok(
        Error.isError(failure) &&
          'path' in failure &&
          failure.path === socketPath,
        `The acquire must fail with the lock server's own start error, got ${String(failure)}`,
      );
      await using term = await socketElection(
        directory.path,
        globalThis,
      ).campaign();
      assert.ok(
        term,
        'A leader whose lock server failed to start must end its term',
      );
    },
  );

  test('a leader whose role listener throws closes its lock server before ending its term', async () => {
    // Arrange: the first acquire in the directory makes this store the leader.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using store = new SocketStore(directory.path, {
      clock: globalThis,
    });
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
    const otherLeader = new SocketStore(directory.path, {
      clock: globalThis,
    });
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
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using store = new SocketStore(directory.path, {
      clock: globalThis,
    });
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
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using leader = new SocketStore(directory.path, {
      clock: globalThis,
    });
    await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
    await using follower = new SocketStore(directory.path, {
      clock: globalThis,
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
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const leader = new SocketStore(directory.path, {
      clock: globalThis,
    });
    await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
    await using first = new SocketStore(directory.path, {
      clock: globalThis,
    });
    await using second = new SocketStore(directory.path, {
      clock: globalThis,
    });
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
    await waitFor(
      () =>
        assert.ok(
          roles.values().some((seen) => seen.includes('leader')),
          'A follower must take over as leader',
        ),
      { signal: t.signal },
    );
    const stayed = roles.values().find((seen) => !seen.includes('leader'));
    await waitFor(
      () =>
        assert.ok(
          stayed?.length === 2,
          'The other follower must follow the new leader',
        ),
      { signal: t.signal },
    );

    // Assert
    assert.deepEqual(stayed, ['follower', 'follower']);
  });
});

describe('Socket store follower failure', () => {
  test('a follower whose role listener throws gives up that acquire and leaves nothing open', async (t) => {
    // Arrange: a leader serves the directory from this process.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using leader = new SocketStore(directory.path, {
      clock: globalThis,
    });
    await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();

    // Act: a follower process whose role listener throws once acquires twice, then just ends.
    await using follower = await new NodeCommand(
      `
				import { Mutex } from ${JSON.stringify(mutexUrl.href)};
				import { SocketStore } from ${JSON.stringify(socketStoreUrl.href)};

				const store = new SocketStore(${JSON.stringify(directory.path)}, { clock: globalThis });
				const mutex = new Mutex(store);
				store.once('role', () => {
					throw new Error('The role listener failed');
				});
				const outcome = (acquiring) =>
					acquiring.then(() => 'granted', (error) => error.message);
				process.send({ type: 'first', outcome: await outcome(mutex.acquire('product:42', async () => {})) });
				process.send({ type: 'second', outcome: await outcome(mutex.acquire('product:42', async () => {})) });
			`,
      { name: 'follower', env: process.env, clock: globalThis },
    ).start({ signal: t.signal });
    // The follower must end on its own once its work is done.
    const end = await untilAborted(follower.process.ended, t.signal);

    // Assert: the failed acquire reported the listener's error, the next one worked, and nothing kept the process alive.
    assert.equal(
      follower.messages.find((message) => message.type === 'first')?.outcome,
      'The role listener failed',
    );
    assert.equal(
      follower.messages.find((message) => message.type === 'second')?.outcome,
      'granted',
    );
    assert.deepEqual(end, { exitCode: 0 }, follower.process.stderrTail());
  });

  test(
    'a follower whose role listener throws closes its connection to the leader',
    onUnixSockets,
    async (t) => {
      // Arrange: a stand-in leader holds the term and serves the socket path; it records when its peer goes away.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _term = await socketElection(
        directory.path,
        globalThis,
      ).campaign();
      const peerClosed = new Latch();
      const leader = createServer((peer) => {
        peer.once('close', () => peerClosed.open());
        // It speaks this protocol, so the follower gets as far as reporting its role.
        peer.once('data', () =>
          peer.write(`${JSON.stringify({ op: 'welcome' })}\n`),
        );
      });
      leader.listen(join(directory.path, 'lock.sock'));
      await once(leader, 'listening');
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
      });
      store.once('role', () => {
        throw new Error('The role listener failed');
      });

      try {
        // Act
        await assert.rejects(store.acquire('product:42'), {
          message: 'The role listener failed',
        });

        // Assert: nothing keeps the connection open after the follower gave it up.
        // The follower must close the connection it gave up.
        await untilAborted(peerClosed.wait(), t.signal);
      } finally {
        leader.close();
      }
    },
  );
});

/**
 * A process that is the only user of the directory: it takes one lock on a
 * clock that never moves, and shuts down cleanly. A wait of a recovery on the
 * clock would never end, so a `done` report shows that the lock took no wait
 * on the clock.
 */
const loneProcess = (directory: string) => `
	import { createClock } from ${JSON.stringify(fakeTimersUrl)};
	import { Mutex } from ${JSON.stringify(mutexUrl.href)};
	import { SocketStore } from ${JSON.stringify(socketStoreUrl.href)};

	const store = new SocketStore(${JSON.stringify(directory)}, { clock: createClock() });
	const mutex = new Mutex(store);
	await mutex.acquire('report:daily', async () => {});
	await store[Symbol.asyncDispose]();
	process.send({ type: 'done' }, () => process.disconnect());
`;

/** The names in the folder `sessions` of `directory`, sorted; none before a store recorded a session. */
async function sessionFiles(directory: string) {
  try {
    return (await readdir(join(directory, 'sessions'))).toSorted();
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

describe('Socket store after a clean shutdown', () => {
  test(
    'a lone process after a clean shutdown acquires at once, also while a recorded process is frozen',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a first process leads, a second process follows it with no
      // key and freezes, and the first process shuts down cleanly.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _successor = succeedLastLeader(directory.path);
      // The first process must lead.
      await using first = await new NodeCommand(
        participant(
          directory.path,
          `${leaderBody}
					await command('dispose');
					await store[Symbol.asyncDispose]();
					process.send({ type: 'done' }, () => process.disconnect());`,
        ),
        { name: 'first', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      // The second process must follow, and so record its session.
      await using frozen = await new NodeCommand(
        participant(directory.path, leaderBody),
        { name: 'frozen', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      frozen.process.signal('SIGSTOP');
      try {
        first.send({ type: 'dispose' });
        // The first process must exit.
        const firstEnd = await untilAborted(first.process.ended, t.signal);
        assert.deepEqual(
          {
            exit: firstEnd,
            done: first.messages.some((message) => message.type === 'done'),
          },
          { exit: { exitCode: 0 }, done: true },
          `The first process must shut down cleanly.\n${first.process.stderrTail()}`,
        );
        const recorded = await sessionFiles(directory.path);

        // Act
        await using next = await new NodeCommand(loneProcess(directory.path), {
          name: 'next',
          env: process.env,
          clock: globalThis,
        }).start({ signal: t.signal });
        // The next process must exit.
        const nextEnd = await untilAborted(next.process.ended, t.signal);

        // Assert
        assert.equal(
          recorded.filter((name) => name.endsWith('.json')).length,
          1,
          'The frozen process must have its session record',
        );
        assert.equal(
          await readFile(join(directory.path, 'leader.epoch'), 'utf8'),
          '2',
          'The next process must lead the second term',
        );
        assert.deepEqual(
          {
            exit: nextEnd,
            done: next.messages.some((message) => message.type === 'done'),
          },
          { exit: { exitCode: 0 }, done: true },
          `The next process must lock with no wait on its clock.\n${next.process.stderrTail()}`,
        );
      } finally {
        frozen.process.signal('SIGCONT');
      }
    },
  );
});

/** A process that follows the leader: it records its session, takes one key, and idles. */
const followerBody = `
	await mutex.acquire('warm-up', async () => {});
	process.send({ type: 'ready' });
`;

describe('Socket store sessions', () => {
  test(
    'a store records its session before its first request and deletes the record and the presence when it is disposed',
    onUnixSockets,
    async (t) => {
      // Arrange: a stand-in leader holds the term, and reads the folder
      // `sessions` when the store says its hello.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _term = await socketElection(
        directory.path,
        globalThis,
      ).campaign();
      const atHello = Promise.withResolvers<{
        session: string;
        files: string[];
        presence: string;
        record: unknown;
      }>();
      await using _leader = await standInServer(
        join(directory.path, 'lock.sock'),
        (peer) => {
          linesOf(peer).once('line', (line) => {
            void (async () => {
              const hello: unknown = JSON.parse(line);
              const session = isRecord(hello) ? String(hello.session) : '';
              const sessions = join(directory.path, 'sessions');
              atHello.resolve({
                session,
                files: await sessionFiles(directory.path),
                presence: FileLock.check(join(sessions, `${session}.presence`)),
                record: JSON.parse(
                  await readFile(join(sessions, `${session}.json`), 'utf8'),
                ),
              });
              peer.write(`${JSON.stringify({ op: 'welcome' })}\n`);
            })();
          });
        },
      );
      const store = new SocketStore(directory.path, {
        clock: globalThis,
        leaseDuration: 4321,
      });
      const before = await sessionFiles(directory.path);

      // Act
      const acquiring = watch(store.acquire('product:42'));
      const seen = await untilAborted(atHello.promise, t.signal);
      await store[Symbol.asyncDispose]();
      const after = await sessionFiles(directory.path);

      // Assert
      const { session } = seen;
      assert.deepEqual(
        before,
        [],
        'A store records nothing before it connects',
      );
      assert.deepEqual(
        seen.files,
        [`${session}.json`, `${session}.presence`],
        'The record and the presence of the session must exist before its hello',
      );
      assert.equal(seen.presence, 'locked', 'The store must hold its presence');
      assert.deepEqual(seen.record, {
        leaseDuration: 4321,
        processId: process.pid,
      });
      assert.deepEqual(
        after,
        [],
        'Disposal must delete the record and the presence',
      );
      assert.equal(acquiring.now.status, 'rejected');
    },
  );

  test(
    'a recorded session whose process was killed ends its recovery at once, and the new leader deletes its files',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a leader, and a holder with a lease duration of one minute
      // that freezes, so the next leader finds it alive and waits for it.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _successor = succeedLastLeader(directory.path);
      // The leader must start.
      await using leader = await new NodeCommand(
        participant(directory.path, leaderBody),
        { name: 'leader', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      // The holder must enter.
      await using holder = await new NodeCommand(
        participant(directory.path, holderBody, { leaseDuration: 60_000 }),
        { name: 'holder', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'entered' }, signal: t.signal });
      holder.process.signal('SIGSTOP');
      leader.process.signal('SIGKILL');
      await leader.process.ended;
      // The new leader runs its checks and deadlines on a clock of the test.
      const clock = createClock();
      await using store = new SocketStore(directory.path, { clock });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));
      const acquiring = store.acquire('product:42', { signal: t.signal });
      await waitFor(
        () => assert.deepEqual(roles, ['leader'], 'This store must lead'),
        { signal: t.signal },
      );
      const whileFrozen = await grantedWithin(acquiring, settle);
      const acquired = watch(acquiring);

      // Act: the frozen holder is killed, and the clock moves by steps of the back-off until the key is granted.
      holder.process.signal('SIGKILL');
      await holder.process.ended;
      let moved = 0;
      await waitFor(
        async () => {
          if (acquired.now.status === 'pending') {
            await clock.tickAsync(25);
            moved += 25;
          }
          assert.notEqual(acquired.now.status, 'pending');
        },
        { signal: t.signal, interval: pollInterval },
      );

      // Assert: its recovery ends at a check of its presence, long before its
      // lease duration, so its key is free, and only the files of this store are left.
      assert.equal(
        whileFrozen,
        'waiting',
        'The new leader must wait for a recorded session that still runs',
      );
      assert.ok(
        moved <= 1200,
        `The key of the killed holder must be granted within one step of the back-off, at most 1200 ms of the clock, not at its lease duration of 60 s; moved ${moved} ms`,
      );
      await (await acquiring)[Symbol.asyncDispose]();
      const files = await sessionFiles(directory.path);
      assert.equal(
        files.length,
        2,
        `Only the record and the presence of this store may be left, got ${JSON.stringify(files)}`,
      );
    },
  );

  test('a recorded session whose process was killed before the failover is not waited for, and the listing deletes its files', async (t) => {
    // Arrange: a leader, and a holder with a lease duration of one minute; both are killed.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using _successor = succeedLastLeader(directory.path);
    // The leader must start.
    await using leader = await new NodeCommand(
      participant(directory.path, leaderBody),
      { name: 'leader', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'ready' }, signal: t.signal });
    // The holder must enter.
    await using holder = await new NodeCommand(
      participant(directory.path, holderBody, { leaseDuration: 60_000 }),
      { name: 'holder', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'entered' }, signal: t.signal });
    holder.process.signal('SIGKILL');
    await holder.process.ended;
    leader.process.signal('SIGKILL');
    await leader.process.ended;
    // The clock of the new leader never moves, so no deadline and no check at a step of the back-off can end a recovery.
    await using store = new SocketStore(directory.path, {
      clock: createClock(),
    });
    const roles: SocketRole[] = [];
    store.on('role', (role) => roles.push(role));

    // Act
    const lease = await store.acquire('product:42', { signal: t.signal });
    await lease[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(roles, ['leader']);
    const files = await sessionFiles(directory.path);
    assert.equal(
      files.length,
      2,
      `Only the record and the presence of this store may be left, got ${JSON.stringify(files)}`,
    );
  });

  test('a presence file with no record, of a session that runs and has not written its record yet, stays after the recovery of the next leader', async (t) => {
    // Arrange: a leader that is killed, so the next leader recovers.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using _successor = succeedLastLeader(directory.path);
    // The leader must start.
    await using leader = await new NodeCommand(
      participant(directory.path, leaderBody),
      { name: 'leader', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'ready' }, signal: t.signal });
    // No operation holds a session between its presence and its record, so
    // the test takes a presence at the path of a session and keeps it, as a
    // session that is starting holds it.
    const sessions = join(directory.path, 'sessions');
    await mkdir(sessions, { recursive: true });
    const starting = `${randomUUID()}.presence`;
    using presence = Presence.tryOpen(join(sessions, starting));
    assert.ok(presence, 'The starting session must get its presence');
    leader.process.signal('SIGKILL');
    await leader.process.ended;
    // The clock of the new leader never moves, so no wait on it ends the recovery.
    await using store = new SocketStore(directory.path, {
      clock: createClock(),
    });
    const roles: SocketRole[] = [];
    store.on('role', (role) => roles.push(role));

    // Act
    const lease = await store.acquire('product:42', { signal: t.signal });
    await lease[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(roles, ['leader']);
    const files = await sessionFiles(directory.path);
    assert.ok(
      files.includes(starting),
      `The recovery must keep the presence file of a session that runs, got ${JSON.stringify(files)}`,
    );
  });

  test('a presence file with no record, of a session that stopped after it took its presence and before it wrote its record, is deleted by the recovery of the next leader', async (t) => {
    // Arrange: a leader that is killed, so the next leader recovers.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using _successor = succeedLastLeader(directory.path);
    // The leader must start.
    await using leader = await new NodeCommand(
      participant(directory.path, leaderBody),
      { name: 'leader', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'ready' }, signal: t.signal });
    // No operation stops a session between its presence and its record, so
    // the test takes and ends a presence at the path of a session, as a
    // session that died at that step leaves it.
    const sessions = join(directory.path, 'sessions');
    await mkdir(sessions, { recursive: true });
    const stopped = `${randomUUID()}.presence`;
    const presence = Presence.tryOpen(join(sessions, stopped));
    assert.ok(presence, 'The stopped session must get its presence');
    presence[Symbol.dispose]();
    leader.process.signal('SIGKILL');
    await leader.process.ended;
    // The clock of the new leader never moves, so no wait on it ends the recovery.
    await using store = new SocketStore(directory.path, {
      clock: createClock(),
    });
    const roles: SocketRole[] = [];
    store.on('role', (role) => roles.push(role));

    // Act
    const lease = await store.acquire('product:42', { signal: t.signal });
    await lease[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(roles, ['leader']);
    const files = await sessionFiles(directory.path);
    assert.ok(
      !files.includes(stopped),
      `The recovery must delete the presence file that has no record, got ${JSON.stringify(files)}`,
    );
    assert.equal(
      files.length,
      2,
      `Only the record and the presence of this store may be left, got ${JSON.stringify(files)}`,
    );
  });

  test(
    'a frozen process that holds no key delays a grant after a failover until its lease duration ends, and no longer',
    {
      skip:
        process.platform === 'win32'
          ? 'Windows cannot freeze a process with SIGSTOP'
          : false,
    },
    async (t) => {
      // Arrange: a leader, and a follower with a lease duration of 700 ms that holds no key and freezes.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _successor = succeedLastLeader(directory.path);
      // The leader must start.
      await using leader = await new NodeCommand(
        participant(directory.path, leaderBody),
        { name: 'leader', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      // The follower must record its session.
      await using frozen = await new NodeCommand(
        participant(directory.path, followerBody, { leaseDuration: 700 }),
        { name: 'frozen', env: process.env, clock: globalThis },
      ).start({ ready: { message: 'ready' }, signal: t.signal });
      frozen.process.signal('SIGSTOP');
      try {
        leader.process.signal('SIGKILL');
        await leader.process.ended;
        // The new leader runs its deadlines on a clock of the test.
        const clock = createClock();
        await using store = new SocketStore(directory.path, { clock });
        const roles: SocketRole[] = [];
        store.on('role', (role) => roles.push(role));
        const acquiring = store.acquire('product:42', { signal: t.signal });
        await waitFor(
          () => assert.deepEqual(roles, ['leader'], 'This store must lead'),
          { signal: t.signal },
        );

        // Act
        await clock.tickAsync(699);
        const beforeDeadline = await grantedWithin(acquiring, settle);
        await clock.tickAsync(1);

        // Assert
        assert.equal(
          beforeDeadline,
          'waiting',
          'The new leader must wait for the frozen session until its lease duration ends',
        );
        // The key must be granted at the deadline, while the session is still frozen
        const lease = await untilAborted(acquiring, t.signal);
        await lease[Symbol.asyncDispose]();
        const records = (await sessionFiles(directory.path)).filter((name) =>
          name.endsWith('.json'),
        );
        assert.equal(
          records.length,
          2,
          'A session that missed its lease may still run, so its record stays',
        );
      } finally {
        frozen.process.signal('SIGCONT');
      }
    },
  );
});
