import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { type Socket, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { SqliteElection } from '@zukhruf/election';
import { TemporaryFiles, isErrno } from '@zukhruf/fs';
import { NodeCommand, type NodeProcess } from '@zukhruf/process';
import { waitFor } from '@zukhruf/testing/async';

import { SingleFlight } from './index.ts';
import {
  type CallerOptions,
  callerSource,
  journalOf,
} from './testing/caller.ts';
import { succeedLastLeader } from './testing/succeed-last-leader.ts';

const flightElectionUrl = new URL(
  './connection/flight-election.ts',
  import.meta.url,
);

const onUnix = {
  skip:
    process.platform === 'win32'
      ? 'Stopping and resuming a process needs POSIX signals'
      : false,
};

/** A caller process on `directory`, ready for orders. */
async function caller(
  t: TestContext,
  directory: string,
  name: string,
  options?: CallerOptions,
) {
  return new NodeCommand(callerSource(directory, options), {
    name,
    env: process.env,
    clock: globalThis,
  }).start({ ready: { message: 'ready' }, signal: t.signal });
}

/**
 * The coordinator, by construction: the first process that makes a call while
 * no other process uses the directory wins the first term.
 */
async function coordinatorOf(
  t: TestContext,
  directory: string,
  options?: CallerOptions,
) {
  const coordinator = await caller(t, directory, 'coordinator', options);
  coordinator.send({ type: 'run', call: 'warm-up', key: 'warm-up' });
  await heard(t, coordinator, 'leading', 'warm-up');
  coordinator.send({ type: 'finish', call: 'warm-up', value: 'warm' });
  await heard(t, coordinator, 'value', 'warm-up');
  return coordinator;
}

/** Waits until `worker` reported `type` for `call`, and returns that report. */
async function heard(
  t: TestContext,
  worker: NodeProcess,
  type: string,
  call: string,
) {
  return worker.next(
    (message) => message.type === type && message.call === call,
    { signal: t.signal },
  );
}

/** Whether the call `call` of `worker` leads by now. */
function led(worker: NodeProcess, call: string) {
  return worker.messages.some(
    (message) => message.type === 'leading' && message.call === call,
  );
}

/**
 * Waits until `worker` reported one of `types` for `call`, and returns the
 * first such report, so a test sees a wrong answer at once instead of waiting
 * out the one it expects.
 */
async function firstOf(
  t: TestContext,
  worker: NodeProcess,
  call: string,
  types: readonly string[],
) {
  return worker.next(
    (message) => message.call === call && types.includes(message.type),
    { signal: t.signal },
  );
}

/** Runs `key` in `worker` as the call `call`. */
function run(worker: NodeProcess, call: string, key: string) {
  worker.send({ type: 'run', call, key });
}

/** The runs of the work, as `<process>:work:<key>`, in order. */
async function journal(directory: string) {
  const text = await readFile(journalOf(directory), 'utf8');
  return text.split('\n').filter(Boolean);
}

async function epochOf(directory: string) {
  return readFile(join(directory, 'flight.epoch'), 'utf8').catch(
    (error: unknown) => {
      if (isErrno(error, 'ENOENT')) return '';
      throw error;
    },
  );
}

describe('A single flight across processes when a leader stops', () => {
  test('a joiner whose leader process stops gets FlightInterruptedError, and its next call leads a new flight', async (t) => {
    // Arrange: the coordinator, a leader in its own process, and a joiner in another.
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using _coordinator = await coordinatorOf(t, directory.path);
    await using leader = await caller(t, directory.path, 'leader');
    run(leader, 'l', 'sync');
    await heard(t, leader, 'leading', 'l');
    await using joiner = await caller(t, directory.path, 'joiner');
    run(joiner, 'j', 'sync');
    await heard(t, joiner, 'joined', 'j');

    // Act
    leader.process.signal('SIGKILL');
    await leader.process.ended;
    // The coordinator lives, so it learns of the stop from the closed connection at once, not from a timeout.
    const interrupted = await heard(t, joiner, 'error', 'j');
    run(joiner, 'next', 'sync');
    await heard(t, joiner, 'leading', 'next');
    joiner.send({ type: 'finish', call: 'next', value: 'second' });
    const next = await heard(t, joiner, 'value', 'next');

    // Assert
    assert.equal(interrupted.name, 'FlightInterruptedError');
    assert.deepEqual(next.value, 'second');
    assert.equal(next.joined, false);
    assert.deepEqual(await journal(directory.path), [
      'coordinator:work:warm-up',
      'leader:work:sync',
      'joiner:work:sync',
    ]);
  });

  test('joiners of a leader that was also the coordinator get FlightInterruptedError from the next coordinator, and nobody runs the work again', async (t) => {
    // Arrange: the coordinator leads the flight itself, and two processes join it.
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using coordinator = await caller(t, directory.path, 'coordinator');
    run(coordinator, 'l', 'sync');
    await heard(t, coordinator, 'leading', 'l');
    await using first = await caller(t, directory.path, 'first');
    run(first, 'j', 'sync');
    await heard(t, first, 'joined', 'j');
    await using second = await caller(t, directory.path, 'second');
    run(second, 'j', 'sync');
    await heard(t, second, 'joined', 'j');

    // Act: a joiner's process takes over. The leader died with the coordinator, so nobody reasserts its flight.
    coordinator.process.signal('SIGKILL');
    await coordinator.process.ended;
    const firstEnd = await heard(t, first, 'error', 'j');
    const secondEnd = await heard(t, second, 'error', 'j');

    // Assert
    assert.equal(firstEnd.name, 'FlightInterruptedError');
    assert.equal(secondEnd.name, 'FlightInterruptedError');
    assert.equal(await epochOf(directory.path), '2');
    assert.deepEqual(await journal(directory.path), ['coordinator:work:sync']);
  });

  test('a fresh run of a key whose leader disposed its single flight while the work runs starts the work only once that work ended', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using _coordinator = await coordinatorOf(t, directory.path);
    await using leader = await caller(t, directory.path, 'leader');
    run(leader, 'l', 'sync');
    await heard(t, leader, 'leading', 'l');
    await using probe = await caller(t, directory.path, 'probe');

    // Act: the coordinator decides one connection's requests in order, so
    // once the probe's run of another key, sent after the fresh run, has its
    // answer, the fresh run had its chance to lead.
    leader.send({ type: 'dispose' });
    await leader.next('disposed', { signal: t.signal });
    run(probe, 'fresh', 'sync');
    await heard(t, probe, 'called', 'fresh');
    run(probe, 'other', 'other');
    await heard(t, probe, 'leading', 'other');
    probe.send({ type: 'finish', call: 'other', value: 'other' });
    await heard(t, probe, 'value', 'other');
    const ledBesideWork = led(probe, 'fresh');

    // Assert
    assert.equal(
      ledBesideWork,
      false,
      "The fresh run led while the disposed leader's work still ran",
    );

    // Act: the work ends. A disposed leader cannot deliver its outcome, so
    // the fresh run cannot join it.
    leader.send({ type: 'finish', call: 'l', value: 'unheard' });
    const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);

    // Assert
    assert.equal(
      first.type,
      'leading',
      'The fresh run joined a flight whose disposed leader cannot deliver its outcome',
    );

    // Act
    probe.send({ type: 'finish', call: 'fresh', value: 'second' });
    const fresh = await heard(t, probe, 'value', 'fresh');

    // Assert
    assert.equal(
      fresh.value,
      'second',
      'The fresh run did not get the value of its own work',
    );
    assert.equal(
      fresh.joined,
      false,
      'The fresh run joined instead of leading',
    );
    assert.deepEqual(
      (await journal(directory.path)).filter((line) => line.endsWith(':sync')),
      ['leader:work:sync', 'probe:work:sync'],
      'The work of the key did not run once after the other',
    );
  });
});

/** Waits until a new coordinator won its term: it records the term's epoch before it serves. */
async function newTerm(t: TestContext, directory: string, epoch: string) {
  await waitFor(async () => assert.equal(await epochOf(directory), epoch), {
    signal: t.signal,
  });
}

/**
 * Stops `coordinator`, and makes `next` its successor by construction: the
 * other processes are frozen until `next`, the only one left to campaign,
 * has won the term. `next` must have a connection already, so it notices the
 * loss and campaigns at once.
 */
async function handOver(
  t: TestContext,
  directory: string,
  coordinator: NodeProcess,
  frozen: NodeProcess[],
) {
  for (const worker of frozen) worker.process.signal('SIGSTOP');
  try {
    coordinator.process.signal('SIGKILL');
    await coordinator.process.ended;
    await newTerm(t, directory, '2');
  } finally {
    for (const worker of frozen) worker.process.signal('SIGCONT');
  }
}

/** A process with an open connection, ready to campaign when the coordinator stops. */
async function connected(t: TestContext, directory: string, name: string) {
  const worker = await caller(t, directory, name);
  await runAlone(t, worker, `${name}-warm-up`);
  return worker;
}

/**
 * Runs the key `call`, which no other process uses, in `worker` until it has
 * its value. The coordinator decides the runs of one connection in the order
 * they arrive, so once this run led, each run that `worker` sent before it
 * was decided.
 */
async function runAlone(t: TestContext, worker: NodeProcess, call: string) {
  run(worker, call, call);
  await heard(t, worker, 'leading', call);
  worker.send({ type: 'finish', call, value: call });
  await heard(t, worker, 'value', call);
}

/**
 * Stops `coordinator`, and serves the next term from this test process as a
 * coordinator that knows no flight: it wins `flight.lock` as the election
 * does, welcomes every process, answers each reassertion `rejected` and each
 * rejoin `interrupted`, and answers nothing else. The `frozen` processes
 * cannot campaign until it serves.
 */
async function rejectingSuccessor(
  directory: string,
  coordinator: NodeProcess,
  frozen: NodeProcess[],
  signal: AbortSignal,
) {
  await using serving = new AsyncDisposableStack();
  for (const worker of frozen) worker.process.signal('SIGSTOP');
  try {
    coordinator.process.signal('SIGKILL');
    await coordinator.process.ended;
    const term = await new SqliteElection({
      clock: globalThis,
      directory,
      claimFile: 'flight.lock',
      epochFile: 'flight.epoch',
    }).campaign({ timeout: Infinity, signal });
    assert.ok(term, 'The test process must win the next term');
    serving.defer(() => term.resign());
    const socketPath = join(directory, 'flight.sock');
    // The dead coordinator left its socket file behind.
    await rm(socketPath, { force: true });
    const peers = new Set<Socket>();
    const server = createServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      // readline emits the socket's errors again, e.g. a reset on Linux when the client closes with unread data.
      const lines = createInterface({ input: peer }).on('error', () => {});
      lines.on('line', (line) => {
        const request: unknown = JSON.parse(line);
        if (typeof request !== 'object' || request === null) return;
        if (!('op' in request)) return;
        if (request.op === 'hello') {
          peer.write('{"op":"welcome"}\n');
          return;
        }
        if (!('id' in request) || typeof request.id !== 'string') return;
        const id = JSON.stringify(request.id);
        if (request.op === 'reassert') {
          peer.write(`{"op":"rejected","id":${id}}\n`);
        }
        if (request.op === 'run' && 'flight' in request) {
          peer.write(`{"op":"interrupted","id":${id}}\n`);
        }
      });
    });
    serving.defer(async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(socketPath);
    await once(server, 'listening');
  } finally {
    for (const worker of frozen) worker.process.signal('SIGCONT');
  }
  return serving.move();
}

describe('A single flight across processes when the coordinator stops', () => {
  test('a leader in another process keeps its flight, and every joiner gets its value', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using coordinator = await coordinatorOf(t, directory.path);
    await using leader = await caller(t, directory.path, 'leader');
    run(leader, 'l', 'sync');
    await heard(t, leader, 'leading', 'l');
    await using joiner = await caller(t, directory.path, 'joiner');
    run(joiner, 'j', 'sync');
    await heard(t, joiner, 'joined', 'j');
    await using probe = await connected(t, directory.path, 'probe');

    // Act: the probe takes over and answers a run of another key, and then the leader lands.
    await handOver(t, directory.path, coordinator, [leader, joiner]);
    await runAlone(t, probe, 'other');
    leader.send({ type: 'finish', call: 'l', value: { files: 42 } });
    const led = await heard(t, leader, 'value', 'l');
    const joined = await heard(t, joiner, 'value', 'j');

    // Assert
    assert.deepEqual(led.value, { files: 42 });
    assert.deepEqual(joined.value, { files: 42 });
    assert.equal(joined.joined, true);
    assert.deepEqual(
      (await journal(directory.path)).filter((line) => line.endsWith(':sync')),
      ['leader:work:sync'],
    );
  });

  test('joiners of a flight whose leader stops after a failover get FlightInterruptedError from the next coordinator', async (t) => {
    // Arrange: the leader leads two flights, and the joiner joins both.
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using coordinator = await coordinatorOf(t, directory.path);
    await using leader = await caller(t, directory.path, 'leader');
    run(leader, 'l', 'sync');
    await heard(t, leader, 'leading', 'l');
    run(leader, 'o', 'other');
    await heard(t, leader, 'leading', 'o');
    await using joiner = await caller(t, directory.path, 'joiner');
    run(joiner, 'j', 'sync');
    await heard(t, joiner, 'joined', 'j');
    run(joiner, 'k', 'other');
    await heard(t, joiner, 'joined', 'k');
    await using _probe = await connected(t, directory.path, 'probe');

    // Act: the probe takes over, the leader reasserts its flights to it, and then the leader stops.
    await handOver(t, directory.path, coordinator, [leader, joiner]);
    // The landing of `other` goes out behind the leader's reassertions, so
    // once it reached the joiner, the next coordinator holds both flights.
    leader.send({ type: 'finish', call: 'o', value: 'other' });
    await heard(t, joiner, 'value', 'k');
    leader.process.signal('SIGKILL');
    await leader.process.ended;
    const ended = await heard(t, joiner, 'error', 'j');

    // Assert
    assert.equal(ended.name, 'FlightInterruptedError');
  });
});

describe('A single flight across processes when the coordinator disposes', () => {
  test('a leader in another process keeps its flight when the coordinator disposes, and the joiner gets its value', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using coordinator = await coordinatorOf(t, directory.path);
    await using leader = await caller(t, directory.path, 'leader');
    run(leader, 'l', 'sync');
    await heard(t, leader, 'leading', 'l');
    await using joiner = await caller(t, directory.path, 'joiner');
    run(joiner, 'j', 'sync');
    await heard(t, joiner, 'joined', 'j');

    // Act: the coordinator disposes, and the leader lands at the next coordinator.
    coordinator.send({ type: 'dispose' });
    await coordinator.next('disposed', { signal: t.signal });
    await newTerm(t, directory.path, '2');
    leader.send({ type: 'finish', call: 'l', value: { files: 42 } });
    const led = await heard(t, leader, 'value', 'l');
    const joined = await heard(t, joiner, 'value', 'j');

    // Assert
    assert.deepEqual(led.value, { files: 42 });
    assert.deepEqual(joined.value, { files: 42 });
    assert.equal(joined.joined, true);
    assert.equal(
      leader.messages.some((message) => message.type === 'lost'),
      false,
      'The leader lost its lease',
    );
    assert.deepEqual(
      (await journal(directory.path)).filter((line) => line.endsWith(':sync')),
      ['leader:work:sync'],
    );
  });

  test(
    'a coordinator that stops right after a landing still delivers it to a joiner that reads slowly',
    onUnix,
    async (t) => {
      // Arrange: this process coordinates and leads, and the joiner's process will not read for a while.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using flights = new SingleFlight({
        clock: globalThis,
        directory: directory.path,
        codec: {
          encode: (value: string) => JSON.stringify(value),
          decode: (text) => {
            const value: unknown = JSON.parse(text);
            assert.equal(typeof value, 'string');
            return String(value);
          },
        },
      });
      await flights.run('warm-up', async () => 'warm');
      const started = Promise.withResolvers<void>();
      const ending = Promise.withResolvers<string>();
      const leading = flights.run('sync', async () => {
        started.resolve();
        return ending.promise;
      });
      await started.promise;
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      // Larger than a socket buffer, so most of the landing waits in this process while the joiner is frozen.
      const report = 'x'.repeat(2 * 1024 * 1024);

      // Act: the leader lands, and its process stops coordinating at once.
      joiner.process.signal('SIGSTOP');
      let disposing: Promise<void> | undefined;
      try {
        ending.resolve(report);
        await leading;
        disposing = flights[Symbol.asyncDispose]();
        // The server removes its socket file in the step that closes it and ends each connection.
        await waitFor(
          () =>
            assert.equal(
              existsSync(join(directory.path, 'flight.sock')),
              false,
            ),
          { signal: t.signal },
        );
      } finally {
        joiner.process.signal('SIGCONT');
      }
      await disposing;
      const joined = await heard(t, joiner, 'value', 'j');

      // Assert
      assert.equal(typeof joined.value, 'string');
      assert.equal(String(joined.value).length, report.length);
    },
  );
});

describe('A single flight across processes in the gaps of a failover', () => {
  test(
    'a call that is on its way to a coordinator when the coordinator stops leads or joins at the next one, and is never interrupted',
    onUnix,
    async (t) => {
      // Arrange: the coordinator is frozen, so it never answers the call.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using next = await connected(t, directory.path, 'next');
      coordinator.process.signal('SIGSTOP');
      run(next, 'fresh', 'sync');
      await heard(t, next, 'called', 'fresh');

      // Act: the call joined nothing, so the next coordinator takes it as a new call.
      coordinator.process.signal('SIGKILL');
      await coordinator.process.ended;
      await heard(t, next, 'leading', 'fresh');
      next.send({ type: 'finish', call: 'fresh', value: 'led' });
      const result = await heard(t, next, 'value', 'fresh');

      // Assert
      assert.equal(result.value, 'led');
      assert.equal(result.joined, false);
    },
  );

  test(
    'a leader that lands while it has no coordinator keeps its landing, and the joiners get it after the leader reasserts',
    onUnix,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using _probe = await connected(t, directory.path, 'probe');

      // Act: the work ends while the leader's coordinator is gone. Whichever the
      // leader hears first, the end of its work or the lost connection, its
      // first landing cannot reach a coordinator.
      leader.process.signal('SIGSTOP');
      joiner.process.signal('SIGSTOP');
      try {
        coordinator.process.signal('SIGKILL');
        await coordinator.process.ended;
        await newTerm(t, directory.path, '2');
        leader.send({
          type: 'finish',
          call: 'l',
          value: 'landed in the gap',
        });
      } finally {
        joiner.process.signal('SIGCONT');
        leader.process.signal('SIGCONT');
      }
      const led = await heard(t, leader, 'value', 'l');
      const joined = await heard(t, joiner, 'value', 'j');

      // Assert
      assert.equal(led.value, 'landed in the gap');
      assert.equal(joined.value, 'landed in the gap');
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
      );
    },
  );

  test(
    'a fresh run that comes before the frozen leader reasserts waits, and then joins the flight that its leader reasserted meanwhile',
    onUnix,
    async (t) => {
      // Arrange: the leader is frozen, so its flight is not reasserted when the fresh run arrives.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');
      leader.process.signal('SIGSTOP');
      try {
        coordinator.process.signal('SIGKILL');
        await coordinator.process.ended;
        await newTerm(t, directory.path, '2');

        // Act
        run(probe, 'fresh', 'sync');
      } finally {
        leader.process.signal('SIGCONT');
      }
      await heard(t, probe, 'joined', 'fresh');
      leader.send({ type: 'finish', call: 'l', value: 'once' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert: the fresh run never led beside the frozen leader.
      assert.equal(fresh.value, 'once');
      assert.equal(fresh.joined, true);
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
      );
    },
  );

  test('a fresh run of a key that no process holds leads after the coordinator stops', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using coordinator = await coordinatorOf(t, directory.path);
    await using probe = await connected(t, directory.path, 'probe');

    // Act
    coordinator.process.signal('SIGKILL');
    await coordinator.process.ended;
    await newTerm(t, directory.path, '2');
    run(probe, 'fresh', 'sync');

    // Assert
    await heard(t, probe, 'leading', 'fresh');
  });

  test(
    'a fresh run after the reasserted flight landed leads a new flight, and never gets the old value',
    onUnix,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');
      await handOver(t, directory.path, coordinator, [leader, joiner]);
      leader.send({ type: 'finish', call: 'l', value: 'first' });
      await heard(t, joiner, 'value', 'j');

      // Act: the first flight ended at the next coordinator; this run comes after it.
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'leading', 'fresh');
      probe.send({ type: 'finish', call: 'fresh', value: 'second' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert
      assert.equal(fresh.value, 'second');
      assert.equal(fresh.joined, false);
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync', 'probe:work:sync'],
      );
    },
  );

  test(
    'a leader whose work throws after its lease is lost rejects with LeaseLostError that carries the error, and its joiners get FlightInterruptedError',
    onUnix,
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the leader's reassertion.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using _next = await rejectingSuccessor(
        directory.path,
        coordinator,
        [leader, joiner],
        t.signal,
      );
      const lost = await heard(t, leader, 'lost', 'l');

      // Act: the work fails with its own error, not with the reason of the lost lease.
      leader.send({
        type: 'fail',
        call: 'l',
        message: 'The disk is full',
        code: 'ENOSPC',
      });
      const led = await heard(t, leader, 'error', 'l');
      const joined = await heard(t, joiner, 'error', 'j');

      // Assert
      assert.equal(lost.reason, 'LeaseLostError');
      assert.equal(led.name, 'LeaseLostError');
      assert.equal(led.subject, 'sync');
      assert.deepEqual(led.cause, {
        message: 'The disk is full',
        code: 'ENOSPC',
      });
      assert.equal(joined.name, 'FlightInterruptedError');
    },
  );

  test(
    'a leader whose work throws the reason of its lost lease rejects with that LeaseLostError, not with a second one around it',
    onUnix,
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the leader's reassertion.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using _next = await rejectingSuccessor(
        directory.path,
        coordinator,
        [leader, joiner],
        t.signal,
      );
      await heard(t, leader, 'lost', 'l');

      // Act: the work stops with signal.throwIfAborted().
      leader.send({ type: 'throw-reason', call: 'l' });
      const led = await heard(t, leader, 'error', 'l');

      // Assert: the reason of the signal has no cause; a second LeaseLostError would carry the first as its cause.
      assert.equal(led.name, 'LeaseLostError');
      assert.equal(led.subject, 'sync');
      assert.equal(led.cause, undefined);
    },
  );

  test(
    'a leader whose codec cannot encode the value after its lease is lost rejects with LeaseLostError that carries the codec error',
    onUnix,
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the leader's reassertion.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader', {
        codec: 'encode-throws',
      });
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using _next = await rejectingSuccessor(
        directory.path,
        coordinator,
        [leader, joiner],
        t.signal,
      );
      await heard(t, leader, 'lost', 'l');

      // Act
      leader.send({ type: 'finish', call: 'l', value: 'stale' });
      const led = await heard(t, leader, 'error', 'l');

      // Assert
      assert.equal(led.name, 'LeaseLostError');
      assert.equal(led.subject, 'sync');
      assert.deepEqual(led.cause, {
        message: 'This value cannot be encoded',
        code: undefined,
      });
    },
  );

  test(
    'a leader whose reassertion is rejected keeps its key until its work ends, so a run in another process leads only after that work ended',
    onUnix,
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the
      // leader's reassertion; then it stops, and a process of the group
      // coordinates the term after it.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');
      {
        await using _next = await rejectingSuccessor(
          directory.path,
          coordinator,
          [leader, probe],
          t.signal,
        );
        await heard(t, leader, 'lost', 'l');
      }
      await newTerm(t, directory.path, '3');

      // Act: a run of the key while the leader's work runs on. A run of
      // another key, sent after it, is decided after it.
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'called', 'fresh');
      await runAlone(t, probe, 'after');
      const ledBesideWork = led(probe, 'fresh');
      leader.send({ type: 'finish', call: 'l', value: 'stale' });
      const ended = await heard(t, leader, 'error', 'l');
      const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);
      probe.send({ type: 'finish', call: 'fresh', value: 'second' });
      await heard(t, probe, 'value', 'fresh');

      // Assert
      assert.equal(
        ledBesideWork,
        false,
        "The fresh run led while the lost leader's work still ran",
      );
      assert.equal(ended.name, 'LeaseLostError');
      assert.equal(
        first.type,
        'leading',
        'The key was not free once the work ended',
      );
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync', 'probe:work:sync'],
      );
    },
  );

  test(
    'when the next coordinator stops too, the flight survives both, and the joiner gets its value',
    onUnix,
    async (t) => {
      // Arrange: the leader leads two flights, and the joiner joins both.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      run(leader, 'o', 'other');
      await heard(t, leader, 'leading', 'o');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      run(joiner, 'k', 'other');
      await heard(t, joiner, 'joined', 'k');
      await using probe = await connected(t, directory.path, 'probe');
      await handOver(t, directory.path, coordinator, [leader, joiner]);
      // Both processes re-sent their flights to the probe before the landing of `other` reached the joiner.
      leader.send({ type: 'finish', call: 'o', value: 'other' });
      await heard(t, joiner, 'value', 'k');

      // Act: the probe stops too, and a third term begins.
      probe.process.signal('SIGKILL');
      await probe.process.ended;
      await newTerm(t, directory.path, '3');
      leader.send({ type: 'finish', call: 'l', value: 'survived' });
      const joined = await heard(t, joiner, 'value', 'j');

      // Assert
      assert.equal(joined.value, 'survived');
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
      );
    },
  );
});

describe('A single flight across processes when a leader is frozen past a failover', () => {
  test(
    'a fresh run after the coordinator stops never starts the work beside the frozen leader, and joins its flight once the leader resumes',
    {
      ...onUnix,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run
      // of another key, and for at least `frozenFor` since the handoff began.
      // The freeze length is this test's input, so a timer that outlasts a
      // short freeze cannot stand in for the lock.
      const frozenFor = 2000;
      leader.process.signal('SIGSTOP');
      let ledBesideLeader: boolean;
      try {
        const handoffBegan = performance.now();
        await handOver(t, directory.path, coordinator, []);
        run(probe, 'fresh', 'sync');
        await heard(t, probe, 'called', 'fresh');
        await runAlone(t, probe, 'other');
        await setTimeout(
          Math.max(0, frozenFor - (performance.now() - handoffBegan)),
        );
        ledBesideLeader = led(probe, 'fresh');
      } finally {
        leader.process.signal('SIGCONT');
      }
      const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);

      // Assert
      assert.equal(
        ledBesideLeader,
        false,
        'The fresh run led while the frozen leader ran its work',
      );
      assert.equal(
        first.type,
        'joined',
        'The fresh run started the work beside the frozen leader instead of joining its flight',
      );

      // Act
      leader.send({ type: 'finish', call: 'l', value: 'once' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert
      assert.equal(
        fresh.value,
        'once',
        "The fresh run did not get the leader's value",
      );
      assert.equal(fresh.joined, true, 'The fresh run did not join the leader');
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
        'A second run of the work was journaled',
      );
    },
  );

  test(
    'a fresh run after the coordinator disposes with a flight in progress never starts the work beside the frozen leader, and joins its flight once the leader resumes',
    {
      ...onUnix,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.process.signal('SIGSTOP');
      let ledBesideLeader: boolean;
      try {
        coordinator.send({ type: 'dispose' });
        await coordinator.next('disposed', { signal: t.signal });
        await newTerm(t, directory.path, '2');
        run(probe, 'fresh', 'sync');
        await heard(t, probe, 'called', 'fresh');
        await runAlone(t, probe, 'other');
        ledBesideLeader = led(probe, 'fresh');
      } finally {
        leader.process.signal('SIGCONT');
      }
      const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);

      // Assert
      assert.equal(
        ledBesideLeader,
        false,
        'The fresh run led while the frozen leader ran its work',
      );
      assert.equal(
        first.type,
        'joined',
        'The fresh run started the work beside the frozen leader instead of joining its flight',
      );

      // Act
      leader.send({ type: 'finish', call: 'l', value: 'once' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert
      assert.equal(
        fresh.value,
        'once',
        "The fresh run did not get the leader's value",
      );
      assert.equal(fresh.joined, true, 'The fresh run did not join the leader');
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
        'A second run of the work was journaled',
      );
    },
  );

  test(
    'joiners of a frozen leader get its value once it resumes, and the work never runs again',
    {
      ...onUnix,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.process.signal('SIGSTOP');
      try {
        await handOver(t, directory.path, coordinator, [joiner]);
        await runAlone(t, probe, 'other');
      } finally {
        leader.process.signal('SIGCONT');
      }
      // A client sends its reassertions before any new run on a connection,
      // so once this run leads, the reassertion of `l` went out first.
      run(leader, 'after', 'after');
      await heard(t, leader, 'leading', 'after');
      leader.send({ type: 'finish', call: 'after', value: 'after' });
      await heard(t, leader, 'value', 'after');
      leader.send({ type: 'finish', call: 'l', value: 'kept' });
      const ledEnd = await firstOf(t, leader, 'l', ['value', 'error']);
      const joinedEnd = await firstOf(t, joiner, 'j', ['value', 'error']);

      // Assert
      assert.equal(
        joinedEnd.type,
        'value',
        `The joiner got ${String(joinedEnd.name)} instead of the frozen leader's value`,
      );
      assert.equal(
        joinedEnd.value,
        'kept',
        "The joiner did not get the leader's value",
      );
      assert.equal(
        joinedEnd.joined,
        true,
        'The joiner did not join the leader',
      );
      assert.equal(
        ledEnd.value,
        'kept',
        `The leader got ${String(ledEnd.name)} instead of its own value`,
      );
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
        'A second run of the work was journaled',
      );
    },
  );

  test(
    'joiners of a frozen leader whose work fails once it resumes get FlightFailedError that describes the failure',
    {
      ...onUnix,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.process.signal('SIGSTOP');
      try {
        await handOver(t, directory.path, coordinator, [joiner]);
        await runAlone(t, probe, 'other');
      } finally {
        leader.process.signal('SIGCONT');
      }
      // A client sends its reassertions before any new run on a connection,
      // so once this run leads, the reassertion of `l` went out first.
      run(leader, 'after', 'after');
      await heard(t, leader, 'leading', 'after');
      leader.send({ type: 'finish', call: 'after', value: 'after' });
      await heard(t, leader, 'value', 'after');
      leader.send({
        type: 'fail',
        call: 'l',
        message: 'The disk is full',
        code: 'ENOSPC',
      });
      const joined = await firstOf(t, joiner, 'j', ['value', 'error']);

      // Assert
      assert.equal(
        joined.name,
        'FlightFailedError',
        `The joiner got ${String(joined.name ?? joined.type)} instead of FlightFailedError`,
      );
      assert.deepEqual(
        joined.failure,
        { name: 'Error', message: 'The disk is full', code: 'ENOSPC' },
        "The joiner did not get the failure of the leader's work",
      );
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
        'A second run of the work was journaled',
      );
    },
  );

  test(
    'a leader whose caller cancelled before the freeze still owns its flight, so a fresh run joins it and never starts the work beside it',
    {
      ...onUnix,
    },
    async (t) => {
      // Arrange: the leader's caller stops waiting, and the work runs on.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      leader.send({ type: 'cancel', call: 'l' });
      await heard(t, leader, 'error', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.process.signal('SIGSTOP');
      let ledBesideLeader: boolean;
      try {
        await handOver(t, directory.path, coordinator, []);
        run(probe, 'fresh', 'sync');
        await heard(t, probe, 'called', 'fresh');
        await runAlone(t, probe, 'other');
        ledBesideLeader = led(probe, 'fresh');
      } finally {
        leader.process.signal('SIGCONT');
      }
      const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);

      // Assert
      assert.equal(
        ledBesideLeader,
        false,
        'The fresh run led while the frozen leader ran its work',
      );
      assert.equal(
        first.type,
        'joined',
        'The fresh run started the work beside the frozen leader instead of joining its flight',
      );

      // Act
      leader.send({ type: 'finish', call: 'l', value: 'once' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert
      assert.equal(
        fresh.value,
        'once',
        "The fresh run did not get the leader's value",
      );
      assert.equal(fresh.joined, true, 'The fresh run did not join the leader');
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
        'A second run of the work was journaled',
      );
    },
  );

  test(
    'a frozen leader whose process stops after the next coordinator serves frees its key: a fresh run leads, and its joiners get FlightInterruptedError',
    onUnix,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader never resumes; it stops while frozen.
      leader.process.signal('SIGSTOP');
      try {
        await handOver(t, directory.path, coordinator, [joiner]);
        await runAlone(t, probe, 'other');
        leader.process.signal('SIGKILL');
        await leader.process.ended;
      } finally {
        leader.process.signal('SIGCONT');
      }
      // The joiner waits for no other run: the kernel frees the dead leader's key.
      const joined = await heard(t, joiner, 'error', 'j');
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'leading', 'fresh');
      probe.send({ type: 'finish', call: 'fresh', value: 'again' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert: the current contract for a flight whose leader died.
      assert.equal(fresh.value, 'again');
      assert.equal(fresh.joined, false);
      assert.equal(joined.name, 'FlightInterruptedError');
    },
  );

  test(
    'a run of another key leads and gets its value while the leader of a key is frozen',
    onUnix,
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act
      leader.process.signal('SIGSTOP');
      let other: Awaited<ReturnType<typeof heard>>;
      try {
        await handOver(t, directory.path, coordinator, []);
        run(probe, 'other', 'other');
        await heard(t, probe, 'leading', 'other');
        probe.send({ type: 'finish', call: 'other', value: 'served' });
        other = await heard(t, probe, 'value', 'other');
      } finally {
        leader.process.signal('SIGCONT');
      }

      // Assert
      assert.equal(other.value, 'served');
      assert.equal(other.joined, false);
    },
  );
});

describe('A single flight across processes after a flight lands', () => {
  test('a run in another process after the flight landed leads a new flight, and the work runs again', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('flights-');
    await using _successor = succeedLastLeader(directory.path);
    await using _coordinator = await coordinatorOf(t, directory.path);
    await using leader = await caller(t, directory.path, 'leader');
    run(leader, 'l', 'sync');
    await heard(t, leader, 'leading', 'l');
    leader.send({ type: 'finish', call: 'l', value: 'first' });
    await heard(t, leader, 'value', 'l');
    await using next = await caller(t, directory.path, 'next');

    // Act
    run(next, 'n', 'sync');
    await heard(t, next, 'leading', 'n');
    next.send({ type: 'finish', call: 'n', value: 'second' });
    const second = await heard(t, next, 'value', 'n');

    // Assert
    assert.equal(second.value, 'second');
    assert.equal(second.joined, false);
    assert.deepEqual(
      (await journal(directory.path)).filter((line) => line.endsWith(':sync')),
      ['leader:work:sync', 'next:work:sync'],
    );
  });
});

describe('A single flight across processes when the coordinator freezes', () => {
  // The coordinator's short lease must reach the followers through its
  // single flight: a follower ends a frozen leader after the lease duration
  // of its record, and the default lease duration is 15 s.
  test(
    'a coordinator frozen past its lease duration is ended by a follower, a survivor coordinates, and the joiner gets the outcome of the flight in progress',
    onUnix,
    async (t) => {
      // Arrange: a coordinator with a short lease, a leader in its own
      // process, and a joiner in another.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await coordinatorOf(t, directory.path, {
        leaseDuration: 500,
      });
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      const record = JSON.parse(
        await readFile(join(directory.path, 'flight.lock.leader'), 'utf8'),
      );

      // Act: the coordinator freezes.
      coordinator.process.signal('SIGSTOP');

      // Assert: a follower ended it, a survivor won the next term, and the
      // flight in progress lands for the joiner.
      const end = await untilAborted(coordinator.process.ended, t.signal);
      assert.equal(record.leaseDuration, 500);
      assert.equal(
        end.signal,
        'SIGKILL',
        `A follower must end the frozen coordinator.\n${coordinator.process.stderrTail()}`,
      );
      await newTerm(t, directory.path, '2');
      leader.send({ type: 'finish', call: 'l', value: 'shared' });
      const landed = await heard(t, leader, 'value', 'l');
      const shared = await heard(t, joiner, 'value', 'j');
      assert.equal(landed.value, 'shared');
      assert.equal(shared.value, 'shared');
      assert.equal(shared.joined, true);
      assert.deepEqual(await journal(directory.path), [
        'coordinator:work:warm-up',
        'leader:work:sync',
      ]);
    },
  );

  // The lease, 1500 ms, outlasts the longest step of the back-off, about
  // 1200 ms, so only a watch that lasts across the steps reaches its end.
  test(
    'a process ends a coordinator that froze before its flight server listened, and coordinates',
    onUnix,
    async (t) => {
      // Arrange: a process wins the term with a short lease and freezes
      // before it serves.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _successor = succeedLastLeader(directory.path);
      await using coordinator = await new NodeCommand(
        `import { flightElection } from ${JSON.stringify(flightElectionUrl.href)};
        const term = await flightElection(${JSON.stringify(directory.path)}, globalThis, 1500).campaign();
        // A listener keeps the channel to the test, and so this process, alive.
        process.on('message', () => {});
        process.send({ type: term ? 'coordinating' : 'lost' });`,
        { name: 'coordinator', env: process.env, clock: globalThis },
      ).start({ signal: t.signal });
      const outcome = await coordinator.next(
        (message) => message.type === 'coordinating' || message.type === 'lost',
        { signal: t.signal },
      );
      assert.equal(
        outcome.type,
        'coordinating',
        `The coordinator must win the term.\n${coordinator.process.stderrTail()}`,
      );
      coordinator.process.signal('SIGSTOP');
      await using flights = new SingleFlight<string>({
        clock: globalThis,
        directory: directory.path,
        codec: { encode: (value) => value, decode: (text) => text },
      });

      // Act
      const result = await flights.run('sync', async () => 'ran', {
        signal: t.signal,
      });

      // Assert
      assert.deepEqual(result, { value: 'ran', joined: false });
      const end = await untilAborted(coordinator.process.ended, t.signal);
      assert.equal(
        end.signal,
        'SIGKILL',
        `The process must end the frozen coordinator.\n${coordinator.process.stderrTail()}`,
      );
    },
  );
});
