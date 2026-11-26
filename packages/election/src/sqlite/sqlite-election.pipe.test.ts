import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { type Socket, connect } from 'node:net';
import { join } from 'node:path';
import { type TestContext, describe } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { type Clock, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { type WorkerProcess, startWorker } from '@zukhruf/testing/process';

import { SqliteElection } from '../index.ts';

const indexUrl = new URL('../index.ts', import.meta.url);

/** An election in `directory` with the file names these tests use, on `clock`. */
const electionIn = (directory: string, clock: Clock = globalThis) =>
  new SqliteElection({
    clock,
    directory,
    claimFile: 'term.lock',
    epochFile: 'term.epoch',
  });

/**
 * A process that campaigns with the given lease until it wins, reports it,
 * keeps the term until killed, and answers each message with a pong of its id.
 */
const leaderSource = (
  directory: string,
  { leaseDuration, heartbeatInterval }: Record<string, number>,
) => `
	import { SqliteElection } from ${JSON.stringify(indexUrl.href)};
	setInterval(() => {}, 1000);
	process.on('message', (message) => process.send({ type: 'pong ' + message.id }));
	const term = await new SqliteElection({ clock: globalThis,
		directory: ${JSON.stringify(directory)},
		claimFile: 'term.lock',
		epochFile: 'term.epoch',
		leaseDuration: ${leaseDuration},
		heartbeatInterval: ${heartbeatInterval},
	}).campaign({ timeout: Infinity });
	process.send({ type: term ? 'leader' : 'follower' });
`;

/**
 * A process that holds the claim as @zukhruf/election 0.8.18 and earlier
 * do: the file lock alone, with no pipe and no leader record. It answers
 * each message with a pong of its id.
 */
const publishedLeaderSource = (directory: string) => `
	import { FileLock } from '@zukhruf/fs';
	setInterval(() => {}, 1000);
	process.on('message', (message) => process.send({ type: 'pong ' + message.id }));
	const claim = FileLock.open(${JSON.stringify(join(directory, 'term.lock'))});
	process.send({ type: claim.tryLock() ? 'holding' : 'busy' });
`;

/**
 * A process that leads with an election whose subclass overrides \`watch\`
 * and never calls SqliteElection's, as a host may.
 */
const forgetfulLeaderSource = (
  directory: string,
  { leaseDuration, heartbeatInterval }: Record<string, number>,
) => `
	import { SqliteElection } from ${JSON.stringify(indexUrl.href)};
	class ForgetfulElection extends SqliteElection {
		watch() {
			return { [Symbol.dispose]() {} };
		}
	}
	setInterval(() => {}, 1000);
	process.on('message', (message) => process.send({ type: 'pong ' + message.id }));
	const term = await new ForgetfulElection({ clock: globalThis,
		directory: ${JSON.stringify(directory)},
		claimFile: 'term.lock',
		epochFile: 'term.epoch',
		leaseDuration: ${leaseDuration},
		heartbeatInterval: ${heartbeatInterval},
	}).campaign({ timeout: Infinity });
	process.send({ type: term ? 'leader' : 'follower' });
`;

/**
 * A process that leads on a clock of its own, which first stays still, so it
 * pushes only the heartbeat of each connect, and observes its own term on
 * another clock that it moves past the lease duration. Then its leader sends
 * one more heartbeat, after which it reports the timers of the observer's
 * clock. A witness connection to the pipe tells when that heartbeat went out:
 * the leader writes it to the observer's connection first.
 */
const selfObserverSource = (directory: string) => `
	import { once } from 'node:events';
	import { readFile } from 'node:fs/promises';
	import { connect } from 'node:net';
	import { createClock } from '@sinonjs/fake-timers';
	import { SqliteElection } from ${JSON.stringify(indexUrl.href)};
	setInterval(() => {}, 1000);
	process.on('message', (message) => process.send({ type: 'pong ' + message.id }));
	const electionOn = (clock) => new SqliteElection({ clock,
		directory: ${JSON.stringify(directory)},
		claimFile: 'term.lock',
		epochFile: 'term.epoch',
		leaseDuration: 300,
		heartbeatInterval: 100,
	});
	const leaderClock = createClock();
	const term = await electionOn(leaderClock).campaign();
	const clock = createClock();
	const observer = electionOn(clock).observe();
	let settled = false;
	observer.left.then(() => (settled = true), () => (settled = true));
	// Its one timer is the deadline of the heartbeat: it holds the pipe.
	while (clock.countTimers() !== 1) await new Promise((resolve) => setImmediate(resolve));
	await clock.tickAsync(1_000);
	const { address } = JSON.parse(await readFile(${JSON.stringify(join(directory, 'term.lock.leader'))}, 'utf8'));
	const witness = connect(address);
	await once(witness, 'data');
	const heartbeat = once(witness, 'data');
	await leaderClock.tickAsync(100);
	await heartbeat;
	await new Promise((resolve) => setImmediate(resolve));
	process.send({ type: term ? 'ticked' : 'follower', timers: clock.countTimers() });
	process.on('message', () => process.send({ type: settled ? 'left settled' : 'left unsettled' }));
`;

/**
 * Ends the test's last term: a successor wins in \`directory\` and resigns,
 * so a killed leader's socket file goes with the replaced record. Copied in
 * sqlite-election.test.ts (docs/copied-code.md).
 */
async function succeed(directory: string, signal: AbortSignal) {
  const successor = await electionIn(directory).campaign({
    timeout: Infinity,
    signal,
  });
  assert.ok(successor, 'A successor must win once the last leader ended');
  await successor.resign();
}

/** Resolves when the process answers a message: it runs, and nobody ended it. */
async function answers(t: TestContext, worker: WorkerProcess) {
  const id = randomUUID();
  worker.child.send({ id });
  await worker.next(`pong ${id}`, { signal: t.signal });
}

/** Records how `running` settles, and `done` resolves when it has. */
function track<T>(running: Promise<T>) {
  const state: {
    settled: boolean;
    value?: T;
    error?: unknown;
    done: Promise<unknown>;
  } = {
    settled: false,
    done: running.then(
      (value) => Object.assign(state, { settled: true, value }),
      (error: unknown) => Object.assign(state, { settled: true, error }),
    ),
  };
  return state;
}

/**
 * Waits until the reader's one timer is set: the deadline of the heartbeat
 * once it holds a connection to a live leader's pipe (a leader serves its
 * pipe before it reports, so that connect cannot fail), or the wait of the
 * back-off under a holder that serves no pipe.
 */
async function waitingOnOneTimer(
  t: TestContext,
  clock: { countTimers(): number },
) {
  await waitFor(() => assert.equal(clock.countTimers(), 1), {
    signal: t.signal,
  });
}

/** Windows has no SIGSTOP, so no process there hangs as these tests make it hang. */
const stoppable = {
  skip: process.platform === 'win32' ? 'Windows has no SIGSTOP' : false,
};

/** On Windows a pipe is no file, and it goes with its process. */
const withSocketFiles = {
  skip: process.platform === 'win32' ? 'A pipe on Windows is no file' : false,
};

describe('A candidate that waits on the leader of a SQLite election', () => {
  test('a candidate whose clock never moves takes over as soon as the leader is killed: the close of its pipe wakes it, not a timer', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    await using leader = startWorker(
      leaderSource(directory.path, {
        leaseDuration: 15_000,
        heartbeatInterval: 5_000,
      }),
      'leader',
    );
    await leader.next('leader', { signal: t.signal });
    const clock = createClock();
    const campaigning = track(
      electionIn(directory.path, clock).campaign({ timeout: Infinity }),
    );
    await waitingOnOneTimer(t, clock);

    // Act
    leader.child.kill('SIGKILL');
    await leader.closed;
    await untilAborted(campaigning.done, t.signal);

    // Assert
    await using successor = campaigning.value;
    assert.equal(campaigning.error, undefined);
    assert.equal(successor?.epoch, 2n);
  });

  test(
    'a candidate ends a leader that SIGSTOP stopped once the leader is silent for the lease duration of its record, not of the candidate, and takes the claim',
    stoppable,
    async (t) => {
      // Arrange: the leader asks for 300 ms; the candidate's own default is 15000 ms.
      await using directory = await new TemporaryFiles().directory(
        'election-test-',
      );
      await using leader = startWorker(
        leaderSource(directory.path, {
          leaseDuration: 300,
          heartbeatInterval: 100,
        }),
        'leader',
      );
      await leader.next('leader', { signal: t.signal });
      leader.child.kill('SIGSTOP');
      const clock = createClock();
      const campaigning = track(
        electionIn(directory.path, clock).campaign({ timeout: Infinity }),
      );
      await waitingOnOneTimer(t, clock);

      // Act
      await clock.tickAsync(300);
      await untilAborted(leader.closed, t.signal);
      await untilAborted(campaigning.done, t.signal);

      // Assert
      await using successor = campaigning.value;
      assert.equal(leader.child.signalCode, 'SIGKILL');
      assert.equal(campaigning.error, undefined);
      assert.equal(successor?.epoch, 2n);
    },
  );

  test('a candidate under a living leader that sends its heartbeats ends nothing, also when it waits longer than the lease duration', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const leader = startWorker(
      leaderSource(directory.path, {
        leaseDuration: 1_000,
        heartbeatInterval: 50,
      }),
      'leader',
    );
    try {
      await leader.next('leader', { signal: t.signal });

      // Act
      const outcome = await electionIn(directory.path).campaign({
        timeout: 2_000,
      });

      // Assert
      assert.equal(outcome, undefined);
      await answers(t, leader);
    } finally {
      await leader[Symbol.asyncDispose]();
      await succeed(directory.path, t.signal);
    }
  });

  test('a process id that a record names is never ended while no pipe of that record is held: a candidate past the lease duration and an observer end nothing', async (t) => {
    // Arrange: a leader dies and leaves its record and its socket file. A
    // process that holds the claim as a published version, with no pipe,
    // then has the process id of the record. The rewrite of the record
    // stands for the kernel giving the dead leader's id to that process:
    // platform setup that no operation exposes.
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const recordPath = join(directory.path, 'term.lock.leader');
    await using dead = startWorker(
      leaderSource(directory.path, {
        leaseDuration: 300,
        heartbeatInterval: 100,
      }),
      'dead',
    );
    await dead.next('leader', { signal: t.signal });
    dead.child.kill('SIGKILL');
    await dead.closed;
    const holder = startWorker(publishedLeaderSource(directory.path), 'holder');
    try {
      await holder.next('holding', { signal: t.signal });
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      await writeFile(
        recordPath,
        JSON.stringify({ ...record, processId: holder.child.pid }),
      );
      const clock = createClock();
      using observer = electionIn(directory.path, clock).observe();

      // Act
      const campaigning = track(
        electionIn(directory.path, clock).campaign({ timeout: 5_000 }),
      );
      // The deadline of the campaign and the first wait of its back-off.
      await waitFor(() => assert.equal(clock.countTimers(), 2), {
        signal: t.signal,
      });
      await clock.tickAsync(5_000);
      await untilAborted(campaigning.done, t.signal);

      // Assert
      assert.equal(await observer.left, 'absent');
      assert.equal(campaigning.value, undefined);
      assert.equal(campaigning.error, undefined);
      await answers(t, holder);
    } finally {
      await holder[Symbol.asyncDispose]();
      await succeed(directory.path, t.signal);
    }
  });

  test('a candidate under a holder that serves no pipe tries again after each wait of a capped back-off: 25 ms, 1.6 times longer each time, at most 1000 ms, each ±20 %, and wins at the first try after the holder ends', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    await using holder = startWorker(
      publishedLeaderSource(directory.path),
      'holder',
    );
    await holder.next('holding', { signal: t.signal });
    const clock = createClock();
    const campaigning = track(
      electionIn(directory.path, clock).campaign({ timeout: Infinity }),
    );

    // Act: each wait of the candidate is its only timer.
    const waits: number[] = [];
    for (let retry = 0; retry < 12; retry++) {
      await waitingOnOneTimer(t, clock);
      const before = clock.now;
      await clock.nextAsync();
      waits.push(clock.now - before);
    }
    holder.child.kill('SIGKILL');
    await holder.closed;
    await waitingOnOneTimer(t, clock);
    await clock.nextAsync();
    await untilAborted(campaigning.done, t.signal);

    // Assert
    await using successor = campaigning.value;
    assert.equal(campaigning.error, undefined);
    assert.equal(successor?.epoch, 1n);
    const expected = (retry: number) => Math.min(1000, 25 * 1.6 ** retry);
    // A timer of the clock rounds its time to whole milliseconds, so a wait
    // at the edge of the jitter can be up to 1 ms outside it.
    waits.forEach((wait, retry) => {
      assert.ok(
        wait >= Math.floor(expected(retry) * 0.8) &&
          wait <= Math.ceil(expected(retry) * 1.2),
        `Wait ${retry} was ${wait} ms, not ${expected(retry)} ms ±20 %: ${waits.join(', ')}`,
      );
    });
    // A timer of the clock rounds its time to whole milliseconds, so only a
    // wait more than 1 ms away from the formula shows the jitter.
    assert.ok(
      waits.some((wait, retry) => Math.abs(wait - expected(retry)) > 1),
      `The waits have no jitter: ${waits.join(', ')}`,
    );
  });

  test(
    'a candidate under a leader whose pipe has a full listen queue waits its back-off and ends at its timeout, and an observer reports absent',
    {
      skip:
        process.platform === 'linux'
          ? false
          : 'Only Linux refuses a connect to a full listen queue with EAGAIN; macOS refuses it with ECONNREFUSED, a NoServerError',
    },
    async (t) => {
      // Arrange: a hung leader accepts nothing, so connects fill its queue.
      await using directory = await new TemporaryFiles().directory(
        'election-test-',
      );
      const leader = startWorker(
        leaderSource(directory.path, {
          leaseDuration: 15_000,
          heartbeatInterval: 5_000,
        }),
        'leader',
      );
      const queued: Socket[] = [];
      try {
        await leader.next('leader', { signal: t.signal });
        leader.child.kill('SIGSTOP');
        const { address } = JSON.parse(
          await readFile(join(directory.path, 'term.lock.leader'), 'utf8'),
        );
        for (let refused = false; !refused;) {
          const socket = connect(address);
          queued.push(socket);
          refused = await new Promise<boolean>((resolve, reject) => {
            socket.once('connect', () => resolve(false));
            socket.once('error', (error: NodeJS.ErrnoException) =>
              error.code === 'EAGAIN' ? resolve(true) : reject(error),
            );
          });
        }
        const clock = createClock();

        // Act
        const campaigning = track(
          electionIn(directory.path, clock).campaign({ timeout: 1_000 }),
        );
        // The deadline of the campaign and the first wait of its back-off.
        await waitFor(
          () => assert.ok(campaigning.settled || clock.countTimers() === 2),
          { signal: t.signal },
        );
        await clock.tickAsync(1_000);
        await untilAborted(campaigning.done, t.signal);
        using observer = electionIn(directory.path, clock).observe();

        // Assert
        assert.equal(campaigning.error, undefined);
        assert.equal(campaigning.value, undefined);
        assert.equal(await observer.left, 'absent');
      } finally {
        for (const socket of queued) socket.destroy();
        await leader[Symbol.asyncDispose]();
        await succeed(directory.path, t.signal);
      }
    },
  );

  test('a campaign with a timeout ends at its deadline on its clock while another process leads', async (t) => {
    // Arrange: the leader is another election of this process, on the real clock.
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    await using _leader = await electionIn(directory.path).campaign();
    const clock = createClock();
    const campaigning = track(
      electionIn(directory.path, clock).campaign({ timeout: 1_000 }),
    );
    await waitFor(() => assert.equal(clock.countTimers(), 2), {
      signal: t.signal,
    });

    // Act
    await clock.tickAsync(999);
    const settledEarly = campaigning.settled;
    await clock.tickAsync(1);
    await untilAborted(campaigning.done, t.signal);

    // Assert
    assert.equal(settledEarly, false, 'The campaign ended before its timeout');
    assert.equal(campaigning.value, undefined);
    assert.equal(campaigning.error, undefined);
  });

  test('a leader that resigns wakes a candidate whose clock never moves, and the candidate finds the claim free', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const first = await electionIn(directory.path).campaign();
    assert.ok(first, 'The first campaign in an empty directory must win');
    const clock = createClock();
    const campaigning = track(
      electionIn(directory.path, clock).campaign({ timeout: Infinity }),
    );
    await waitingOnOneTimer(t, clock);

    // Act
    await first.resign();
    await untilAborted(campaigning.done, t.signal);

    // Assert
    await using successor = campaigning.value;
    assert.equal(campaigning.error, undefined);
    assert.equal(successor?.epoch, 2n);
  });

  test('a campaign that its caller stops while it waits on the leader rejects with the reason', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    await using first = await electionIn(directory.path).campaign();
    assert.ok(first, 'The first campaign in an empty directory must win');
    const clock = createClock();
    const stop = new AbortController();
    const reason = new Error('Stopped while waiting on the leader');
    const campaigning = track(
      electionIn(directory.path, clock).campaign({
        timeout: Infinity,
        signal: stop.signal,
      }),
    );
    await waitingOnOneTimer(t, clock);

    // Act
    stop.abort(reason);
    await untilAborted(campaigning.done, t.signal);

    // Assert
    assert.equal(campaigning.error, reason);
  });
});

describe('The leader of a SQLite election', () => {
  test('a leader records its process id, its pipe and its lease duration, and pushes a heartbeat on its pipe when a reader connects and then every heartbeat interval', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const clock = createClock();
    await using _term = await new SqliteElection({
      clock,
      directory: directory.path,
      claimFile: 'term.lock',
      epochFile: 'term.epoch',
      leaseDuration: 300,
      heartbeatInterval: 100,
    }).campaign();
    const record = JSON.parse(
      await readFile(join(directory.path, 'term.lock.leader'), 'utf8'),
    );
    const socket = connect(record.address);
    const bytes: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => bytes.push(chunk));
    const received = () => Buffer.concat(bytes).length;

    try {
      // Act
      await waitFor(() => assert.equal(received(), 1), {
        signal: t.signal,
      });
      await clock.tickAsync(100);
      await waitFor(() => assert.equal(received(), 2), {
        signal: t.signal,
      });
      await clock.tickAsync(100);
      await waitFor(() => assert.equal(received(), 3), {
        signal: t.signal,
      });

      // Assert
      assert.deepEqual(
        { ...record, address: typeof record.address },
        {
          epoch: '1',
          processId: process.pid,
          address: 'string',
          leaseDuration: 300,
        },
      );
    } finally {
      socket.destroy();
    }
  });

  test("a leader whose election overrides watch without calling SqliteElection's still pushes its heartbeats, and an observer in another process ends nothing past the lease duration", async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const leader = startWorker(
      forgetfulLeaderSource(directory.path, {
        leaseDuration: 1_000,
        heartbeatInterval: 50,
      }),
      'leader',
    );
    try {
      await leader.next('leader', { signal: t.signal });
      using observer = electionIn(directory.path).observe();
      const left = track(observer.left);
      const record = JSON.parse(
        await readFile(join(directory.path, 'term.lock.leader'), 'utf8'),
      );
      const socket = connect(record.address);
      const bytes: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => bytes.push(chunk));
      const received = () => Buffer.concat(bytes).length;

      try {
        // Act: 30 heartbeats span 1450 ms, past the lease duration of 1000 ms.
        await waitFor(
          () =>
            assert.ok(
              received() >= 30,
              `The leader sent ${received()} heartbeats.\n${leader.stderr}`,
            ),
          { signal: t.signal },
        );

        // Assert
        await answers(t, leader);
        assert.equal(left.settled, false);
      } finally {
        socket.destroy();
      }
    } finally {
      await leader[Symbol.asyncDispose]();
      await succeed(directory.path, t.signal);
    }
  });

  test(
    'a successor removes the socket file of the leader that was killed before it, which the record it replaces names',
    withSocketFiles,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'election-test-',
      );
      await using leader = startWorker(
        leaderSource(directory.path, {
          leaseDuration: 15_000,
          heartbeatInterval: 5_000,
        }),
        'leader',
      );
      await leader.next('leader', { signal: t.signal });
      const { address } = JSON.parse(
        await readFile(join(directory.path, 'term.lock.leader'), 'utf8'),
      );
      leader.child.kill('SIGKILL');
      await leader.closed;
      await access(address);

      // Act
      await succeed(directory.path, t.signal);

      // Assert
      await assert.rejects(access(address), { code: 'ENOENT' });
    },
  );

  test(
    'a successor wins when the socket file of the leader that was killed before it is already gone',
    withSocketFiles,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'election-test-',
      );
      await using leader = startWorker(
        leaderSource(directory.path, {
          leaseDuration: 15_000,
          heartbeatInterval: 5_000,
        }),
        'leader',
      );
      await leader.next('leader', { signal: t.signal });
      const { address } = JSON.parse(
        await readFile(join(directory.path, 'term.lock.leader'), 'utf8'),
      );
      leader.child.kill('SIGKILL');
      await leader.closed;
      await rm(address);

      // Act
      const successor = await electionIn(directory.path).campaign();

      // Assert
      await using _successor = successor;
      assert.equal(successor?.epoch, 2n);
    },
  );

  test('a leader stops its heartbeat when its term closes: its clock holds no timer after the resign', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const clock = createClock();
    const term = await new SqliteElection({
      clock,
      directory: directory.path,
      claimFile: 'term.lock',
      epochFile: 'term.epoch',
      leaseDuration: 300,
      heartbeatInterval: 100,
    }).campaign();
    assert.ok(term, 'The first campaign in an empty directory must win');
    const timersWhileLeading = clock.countTimers();

    // Act
    await term.resign();

    // Assert
    assert.ok(timersWhileLeading > 0, 'A leader must time its heartbeat');
    assert.equal(clock.countTimers(), 0);
  });

  void test.each(
    [
      { leaseDuration: 300, heartbeatInterval: 300 },
      { leaseDuration: 300, heartbeatInterval: 0 },
      { leaseDuration: 300, heartbeatInterval: -1 },
    ],
    (options) =>
      test(`an election refuses heartbeatInterval ${options.heartbeatInterval} with leaseDuration ${options.leaseDuration}: a heartbeat must come more often than the lease ends`, () => {
        // Act and Assert
        assert.throws(
          () =>
            new SqliteElection({
              clock: globalThis,
              directory: '/unused',
              claimFile: 'term.lock',
              epochFile: 'term.epoch',
              ...options,
            }),
          RangeError,
        );
      }),
  );
});

describe('An observer of a SQLite election', () => {
  test('an observer reports closed when the leader is killed', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    await using leader = startWorker(
      leaderSource(directory.path, {
        leaseDuration: 15_000,
        heartbeatInterval: 5_000,
      }),
      'leader',
    );
    await leader.next('leader', { signal: t.signal });
    const clock = createClock();
    using observer = electionIn(directory.path, clock).observe();
    await waitingOnOneTimer(t, clock);

    // Act
    leader.child.kill('SIGKILL');

    // Assert
    assert.equal(await observer.left, 'closed');
    await leader.closed;
    await succeed(directory.path, t.signal);
  });

  test(
    'an observer ends a leader that is silent for the lease duration of its record, and reports ended',
    stoppable,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'election-test-',
      );
      await using leader = startWorker(
        leaderSource(directory.path, {
          leaseDuration: 300,
          heartbeatInterval: 100,
        }),
        'leader',
      );
      await leader.next('leader', { signal: t.signal });
      leader.child.kill('SIGSTOP');
      const clock = createClock();
      using observer = electionIn(directory.path, clock).observe();
      await waitingOnOneTimer(t, clock);

      // Act
      await clock.tickAsync(300);

      // Assert
      assert.equal(await observer.left, 'ended');
      await untilAborted(leader.closed, t.signal);
      assert.equal(leader.child.signalCode, 'SIGKILL');
      await succeed(directory.path, t.signal);
    },
  );

  test('an observer whose leader record names its own process never ends it, also past the lease duration, and sets no new deadline', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );
    const worker = startWorker(selfObserverSource(directory.path), 'worker');
    try {
      // Act
      await worker.next('ticked', { signal: t.signal });

      // Assert
      await answers(t, worker);
      await worker.next('left unsettled', { signal: t.signal });
      assert.equal(
        worker.find('ticked')?.timers,
        0,
        'A heartbeat after the refusal must set no new deadline',
      );
    } finally {
      await worker[Symbol.asyncDispose]();
      await succeed(directory.path, t.signal);
    }
  });

  test('an observer reports absent when no leader ever wrote a record', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory(
      'election-test-',
    );

    // Act
    using observer = electionIn(directory.path).observe();

    // Assert
    assert.equal(await observer.left, 'absent');
  });

  test(
    'a disposed observer ends no silent leader, and its left never settles',
    stoppable,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'election-test-',
      );
      const leader = startWorker(
        leaderSource(directory.path, {
          leaseDuration: 300,
          heartbeatInterval: 100,
        }),
        'leader',
      );
      try {
        await leader.next('leader', { signal: t.signal });
        leader.child.kill('SIGSTOP');
        const clock = createClock();
        const observer = electionIn(directory.path, clock).observe();
        const left = track(observer.left);
        await waitingOnOneTimer(t, clock);

        // Act
        observer[Symbol.dispose]();
        await clock.tickAsync(1_000);
        leader.child.kill('SIGCONT');

        // Assert
        await answers(t, leader);
        assert.equal(left.settled, false);
      } finally {
        await leader[Symbol.asyncDispose]();
        await succeed(directory.path, t.signal);
      }
    },
  );
});
