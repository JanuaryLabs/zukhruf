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

import { SqliteElection } from '@zukhruf/election';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { SingleFlight } from './index.ts';
import {
  type CallerOptions,
  callerSource,
  journalOf,
} from './testing/caller.ts';
import { newProcessTimeout } from './testing/new-process-timeout.ts';
import { type WorkerProcess, startWorker } from './testing/worker-process.ts';

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
  const worker = startWorker(callerSource(directory, options), name);
  await t.waitFor(() => assert.ok(worker.has('ready'), worker.stderr), {
    interval: 5,
    timeout: newProcessTimeout,
  });
  return worker;
}

/**
 * The coordinator, by construction: the first process that makes a call while
 * no other process uses the directory wins the first term.
 */
async function coordinatorOf(t: TestContext, directory: string) {
  const coordinator = await caller(t, directory, 'coordinator');
  coordinator.child.send({ type: 'run', call: 'warm-up', key: 'warm-up' });
  await heard(t, coordinator, 'leading', 'warm-up');
  coordinator.child.send({ type: 'finish', call: 'warm-up', value: 'warm' });
  await heard(t, coordinator, 'value', 'warm-up');
  return coordinator;
}

/** Waits until `worker` reported `type` for `call`, and returns that report. */
async function heard(
  t: TestContext,
  worker: WorkerProcess,
  type: string,
  call: string,
  timeout = newProcessTimeout,
) {
  const find = () =>
    worker.messages.find(
      (message) => message.type === type && message.call === call,
    );
  await t.waitFor(
    () =>
      assert.ok(
        find() !== undefined,
        `No ${type} for ${call}; got ${JSON.stringify(worker.messages)} ${worker.stderr}`,
      ),
    { interval: 5, timeout: timeout },
  );
  const message = find();
  assert.ok(message);
  return message;
}

/** Whether the call `call` of `worker` leads by now. */
function led(worker: WorkerProcess, call: string) {
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
  worker: WorkerProcess,
  call: string,
  types: readonly string[],
) {
  const find = () =>
    worker.messages.find(
      (message) => message.call === call && types.includes(message.type),
    );
  await t.waitFor(
    () =>
      assert.ok(
        find() !== undefined,
        `No ${types.join(' or ')} for ${call}; got ${JSON.stringify(worker.messages)} ${worker.stderr}`,
      ),
    { interval: 5, timeout: newProcessTimeout },
  );
  const message = find();
  assert.ok(message);
  return message;
}

/** Runs `key` in `worker` as the call `call`. */
function run(worker: WorkerProcess, call: string, key: string) {
  worker.child.send({ type: 'run', call, key });
}

/** The runs of the work, as `<process>:work:<key>`, in order. */
async function journal(directory: string) {
  const text = await readFile(journalOf(directory), 'utf8');
  return text.split('\n').filter(Boolean);
}

async function epochOf(directory: string) {
  return readFile(join(directory, 'flight.epoch'), 'utf8').catch(() => '');
}

describe('A single flight across processes when a leader stops', () => {
  test(
    'a joiner whose leader process stops gets FlightInterruptedError at once, and its next call leads a new flight',
    { timeout: 30_000 },
    async (t) => {
      // Arrange: the coordinator, a leader in its own process, and a joiner in another.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');

      // Act
      leader.child.kill('SIGKILL');
      await leader.closed;
      // The coordinator lives, so it learns of the stop from the closed connection at once, not from a timeout.
      const interrupted = await heard(t, joiner, 'error', 'j', 1000);
      run(joiner, 'next', 'sync');
      await heard(t, joiner, 'leading', 'next');
      joiner.child.send({ type: 'finish', call: 'next', value: 'second' });
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
    },
  );

  test(
    'joiners of a leader that was also the coordinator get FlightInterruptedError from the next coordinator, and nobody runs the work again',
    { timeout: 30_000 },
    async (t) => {
      // Arrange: the coordinator leads the flight itself, and two processes join it.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      coordinator.child.kill('SIGKILL');
      await coordinator.closed;
      const firstEnd = await heard(t, first, 'error', 'j');
      const secondEnd = await heard(t, second, 'error', 'j');

      // Assert
      assert.equal(firstEnd.name, 'FlightInterruptedError');
      assert.equal(secondEnd.name, 'FlightInterruptedError');
      assert.equal(await epochOf(directory.path), '2');
      assert.deepEqual(await journal(directory.path), [
        'coordinator:work:sync',
      ]);
    },
  );

  test(
    'a fresh run of a key whose leader disposed its single flight while the work runs starts the work only once that work ended',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await caller(t, directory.path, 'probe');

      // Act: the coordinator decides one connection's requests in order, so
      // once the probe's run of another key, sent after the fresh run, has its
      // answer, the fresh run had its chance to lead.
      leader.child.send({ type: 'dispose' });
      await t.waitFor(() => assert.ok(leader.has('disposed'), leader.stderr), {
        interval: 5,
        timeout: newProcessTimeout,
      });
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'called', 'fresh');
      run(probe, 'other', 'other');
      await heard(t, probe, 'leading', 'other');
      probe.child.send({ type: 'finish', call: 'other', value: 'other' });
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
      leader.child.send({ type: 'finish', call: 'l', value: 'unheard' });
      const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);

      // Assert
      assert.equal(
        first.type,
        'leading',
        'The fresh run joined a flight whose disposed leader cannot deliver its outcome',
      );

      // Act
      probe.child.send({ type: 'finish', call: 'fresh', value: 'second' });
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
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync', 'probe:work:sync'],
        'The work of the key did not run once after the other',
      );
    },
  );
});

/** Waits until a new coordinator won its term: it records the term's epoch before it serves. */
async function newTerm(t: TestContext, directory: string, epoch: string) {
  await t.waitFor(async () => assert.equal(await epochOf(directory), epoch), {
    interval: 5,
    timeout: newProcessTimeout,
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
  coordinator: WorkerProcess,
  frozen: WorkerProcess[],
) {
  for (const worker of frozen) worker.child.kill('SIGSTOP');
  try {
    coordinator.child.kill('SIGKILL');
    await coordinator.closed;
    await newTerm(t, directory, '2');
  } finally {
    for (const worker of frozen) worker.child.kill('SIGCONT');
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
async function runAlone(t: TestContext, worker: WorkerProcess, call: string) {
  run(worker, call, call);
  await heard(t, worker, 'leading', call);
  worker.child.send({ type: 'finish', call, value: call });
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
  coordinator: WorkerProcess,
  frozen: WorkerProcess[],
) {
  await using serving = new AsyncDisposableStack();
  for (const worker of frozen) worker.child.kill('SIGSTOP');
  try {
    coordinator.child.kill('SIGKILL');
    await coordinator.closed;
    const term = await new SqliteElection({
      directory,
      claimFile: 'flight.lock',
      epochFile: 'flight.epoch',
    }).campaign({ timeout: newProcessTimeout });
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
    for (const worker of frozen) worker.child.kill('SIGCONT');
  }
  return serving.move();
}

describe('A single flight across processes when the coordinator stops', () => {
  test(
    'a leader in another process keeps its flight, and every joiner gets its value',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
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
      leader.child.send({ type: 'finish', call: 'l', value: { files: 42 } });
      const led = await heard(t, leader, 'value', 'l');
      const joined = await heard(t, joiner, 'value', 'j');

      // Assert
      assert.deepEqual(led.value, { files: 42 });
      assert.deepEqual(joined.value, { files: 42 });
      assert.equal(joined.joined, true);
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
      );
    },
  );

  test(
    'joiners of a flight whose leader stops after a failover get FlightInterruptedError from the next coordinator',
    { timeout: 30_000 },
    async (t) => {
      // Arrange: the leader leads two flights, and the joiner joins both.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      leader.child.send({ type: 'finish', call: 'o', value: 'other' });
      await heard(t, joiner, 'value', 'k');
      leader.child.kill('SIGKILL');
      await leader.closed;
      const ended = await heard(t, joiner, 'error', 'j');

      // Assert
      assert.equal(ended.name, 'FlightInterruptedError');
    },
  );
});

describe('A single flight across processes when the coordinator disposes', () => {
  test(
    'a leader in another process keeps its flight when the coordinator disposes, and the joiner gets its value',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');

      // Act: the coordinator disposes, and the leader lands at the next coordinator.
      coordinator.child.send({ type: 'dispose' });
      await t.waitFor(
        () => assert.ok(coordinator.has('disposed'), coordinator.stderr),
        { interval: 5, timeout: newProcessTimeout },
      );
      await newTerm(t, directory.path, '2');
      leader.child.send({ type: 'finish', call: 'l', value: { files: 42 } });
      const led = await heard(t, leader, 'value', 'l');
      const joined = await heard(t, joiner, 'value', 'j');

      // Assert
      assert.deepEqual(led.value, { files: 42 });
      assert.deepEqual(joined.value, { files: 42 });
      assert.equal(joined.joined, true);
      assert.equal(leader.has('lost'), false, 'The leader lost its lease');
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync'],
      );
    },
  );

  test(
    'a coordinator that stops right after a landing still delivers it to a joiner that reads slowly',
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: this process coordinates and leads, and the joiner's process will not read for a while.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using flights = new SingleFlight({
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
      joiner.child.kill('SIGSTOP');
      let disposing: Promise<void> | undefined;
      try {
        ending.resolve(report);
        await leading;
        disposing = flights[Symbol.asyncDispose]();
        // The server removes its socket file in the step that closes it and ends each connection.
        await t.waitFor(
          () =>
            assert.equal(
              existsSync(join(directory.path, 'flight.sock')),
              false,
            ),
          { interval: 5, timeout: newProcessTimeout },
        );
      } finally {
        joiner.child.kill('SIGCONT');
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
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the coordinator is frozen, so it never answers the call.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using next = await connected(t, directory.path, 'next');
      coordinator.child.kill('SIGSTOP');
      run(next, 'fresh', 'sync');
      await heard(t, next, 'called', 'fresh');

      // Act: the call joined nothing, so the next coordinator takes it as a new call.
      coordinator.child.kill('SIGKILL');
      await coordinator.closed;
      await heard(t, next, 'leading', 'fresh');
      next.child.send({ type: 'finish', call: 'fresh', value: 'led' });
      const result = await heard(t, next, 'value', 'fresh');

      // Assert
      assert.equal(result.value, 'led');
      assert.equal(result.joined, false);
    },
  );

  test(
    'a leader that lands while it has no coordinator keeps its landing, and the joiners get it after the leader reasserts',
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
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
      leader.child.kill('SIGSTOP');
      joiner.child.kill('SIGSTOP');
      try {
        coordinator.child.kill('SIGKILL');
        await coordinator.closed;
        await newTerm(t, directory.path, '2');
        leader.child.send({
          type: 'finish',
          call: 'l',
          value: 'landed in the gap',
        });
      } finally {
        joiner.child.kill('SIGCONT');
        leader.child.kill('SIGCONT');
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
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the leader is frozen, so its flight is not reasserted when the fresh run arrives.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');
      leader.child.kill('SIGSTOP');
      try {
        coordinator.child.kill('SIGKILL');
        await coordinator.closed;
        await newTerm(t, directory.path, '2');

        // Act
        run(probe, 'fresh', 'sync');
      } finally {
        leader.child.kill('SIGCONT');
      }
      await heard(t, probe, 'joined', 'fresh');
      leader.child.send({ type: 'finish', call: 'l', value: 'once' });
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

  test(
    'a fresh run of a key that no process holds leads at once after the coordinator stops',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using probe = await connected(t, directory.path, 'probe');

      // Act
      coordinator.child.kill('SIGKILL');
      await coordinator.closed;
      await newTerm(t, directory.path, '2');
      const termSeen = performance.now();
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'leading', 'fresh');
      const waited = performance.now() - termSeen;

      // Assert: a term after a stop used to hold every fresh run for 500 ms (#2549).
      assert.ok(
        waited < 400,
        `The fresh run led ${Math.round(waited)} ms after the next term began`,
      );
    },
  );

  test(
    'a fresh run after the reasserted flight landed leads a new flight, and never gets the old value',
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');
      await handOver(t, directory.path, coordinator, [leader, joiner]);
      leader.child.send({ type: 'finish', call: 'l', value: 'first' });
      await heard(t, joiner, 'value', 'j');

      // Act: the first flight ended at the next coordinator; this run comes after it.
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'leading', 'fresh');
      probe.child.send({ type: 'finish', call: 'fresh', value: 'second' });
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
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the leader's reassertion.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      );
      const lost = await heard(t, leader, 'lost', 'l');

      // Act: the work fails with its own error, not with the reason of the lost lease.
      leader.child.send({
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
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the leader's reassertion.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      );
      await heard(t, leader, 'lost', 'l');

      // Act: the work stops with signal.throwIfAborted().
      leader.child.send({ type: 'throw-reason', call: 'l' });
      const led = await heard(t, leader, 'error', 'l');

      // Assert: the reason of the signal has no cause; a second LeaseLostError would carry the first as its cause.
      assert.equal(led.name, 'LeaseLostError');
      assert.equal(led.subject, 'sync');
      assert.equal(led.cause, undefined);
    },
  );

  test(
    'a leader whose codec cannot encode the value after its lease is lost rejects with LeaseLostError that carries the codec error',
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the leader's reassertion.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      );
      await heard(t, leader, 'lost', 'l');

      // Act
      leader.child.send({ type: 'finish', call: 'l', value: 'stale' });
      const led = await heard(t, leader, 'error', 'l');

      // Assert
      assert.equal(led.name, 'LeaseLostError');
      assert.equal(led.subject, 'sync');
      assert.deepEqual(led.cause, { message: 'This value cannot be encoded' });
    },
  );

  test(
    'a leader whose reassertion is rejected keeps its key until its work ends, so a run in another process leads only after that work ended',
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the next coordinator knows no flight, so it rejects the
      // leader's reassertion; then it stops, and a process of the group
      // coordinates the term after it.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      leader.child.send({ type: 'finish', call: 'l', value: 'stale' });
      const ended = await heard(t, leader, 'error', 'l');
      const first = await firstOf(t, probe, 'fresh', ['leading', 'joined']);
      probe.child.send({ type: 'finish', call: 'fresh', value: 'second' });
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
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange: the leader leads two flights, and the joiner joins both.
      await using directory = await new TemporaryFiles().directory('flights-');
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
      leader.child.send({ type: 'finish', call: 'o', value: 'other' });
      await heard(t, joiner, 'value', 'k');

      // Act: the probe stops too, and a third term begins.
      probe.child.kill('SIGKILL');
      await probe.closed;
      await newTerm(t, directory.path, '3');
      leader.child.send({ type: 'finish', call: 'l', value: 'survived' });
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
      timeout: 30_000,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
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
      leader.child.kill('SIGSTOP');
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
        leader.child.kill('SIGCONT');
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
      leader.child.send({ type: 'finish', call: 'l', value: 'once' });
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
      timeout: 30_000,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.child.kill('SIGSTOP');
      let ledBesideLeader: boolean;
      try {
        coordinator.child.send({ type: 'dispose' });
        await t.waitFor(
          () => assert.ok(coordinator.has('disposed'), coordinator.stderr),
          { interval: 5, timeout: newProcessTimeout },
        );
        await newTerm(t, directory.path, '2');
        run(probe, 'fresh', 'sync');
        await heard(t, probe, 'called', 'fresh');
        await runAlone(t, probe, 'other');
        ledBesideLeader = led(probe, 'fresh');
      } finally {
        leader.child.kill('SIGCONT');
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
      leader.child.send({ type: 'finish', call: 'l', value: 'once' });
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
      timeout: 30_000,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.child.kill('SIGSTOP');
      try {
        await handOver(t, directory.path, coordinator, [joiner]);
        await runAlone(t, probe, 'other');
      } finally {
        leader.child.kill('SIGCONT');
      }
      // A client sends its reassertions before any new run on a connection,
      // so once this run leads, the reassertion of `l` went out first.
      run(leader, 'after', 'after');
      await heard(t, leader, 'leading', 'after');
      leader.child.send({ type: 'finish', call: 'after', value: 'after' });
      await heard(t, leader, 'value', 'after');
      leader.child.send({ type: 'finish', call: 'l', value: 'kept' });
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
      timeout: 30_000,
    },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.child.kill('SIGSTOP');
      try {
        await handOver(t, directory.path, coordinator, [joiner]);
        await runAlone(t, probe, 'other');
      } finally {
        leader.child.kill('SIGCONT');
      }
      // A client sends its reassertions before any new run on a connection,
      // so once this run leads, the reassertion of `l` went out first.
      run(leader, 'after', 'after');
      await heard(t, leader, 'leading', 'after');
      leader.child.send({ type: 'finish', call: 'after', value: 'after' });
      await heard(t, leader, 'value', 'after');
      leader.child.send({
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
      timeout: 30_000,
    },
    async (t) => {
      // Arrange: the leader's caller stops waiting, and the work runs on.
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      leader.child.send({ type: 'cancel', call: 'l' });
      await heard(t, leader, 'error', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader stays frozen until the next coordinator answered a run of another key.
      leader.child.kill('SIGSTOP');
      let ledBesideLeader: boolean;
      try {
        await handOver(t, directory.path, coordinator, []);
        run(probe, 'fresh', 'sync');
        await heard(t, probe, 'called', 'fresh');
        await runAlone(t, probe, 'other');
        ledBesideLeader = led(probe, 'fresh');
      } finally {
        leader.child.kill('SIGCONT');
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
      leader.child.send({ type: 'finish', call: 'l', value: 'once' });
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
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');
      await using probe = await connected(t, directory.path, 'probe');

      // Act: the leader never resumes; it stops while frozen.
      leader.child.kill('SIGSTOP');
      try {
        await handOver(t, directory.path, coordinator, [joiner]);
        await runAlone(t, probe, 'other');
        leader.child.kill('SIGKILL');
        await leader.closed;
      } finally {
        leader.child.kill('SIGCONT');
      }
      // The joiner waits for no other run: the kernel frees the dead leader's key.
      const joined = await heard(t, joiner, 'error', 'j');
      run(probe, 'fresh', 'sync');
      await heard(t, probe, 'leading', 'fresh');
      probe.child.send({ type: 'finish', call: 'fresh', value: 'again' });
      const fresh = await heard(t, probe, 'value', 'fresh');

      // Assert: the current contract for a flight whose leader died.
      assert.equal(fresh.value, 'again');
      assert.equal(fresh.joined, false);
      assert.equal(joined.name, 'FlightInterruptedError');
    },
  );

  test(
    'a run of another key leads and gets its value while the leader of a key is frozen',
    { ...onUnix, timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      await using probe = await connected(t, directory.path, 'probe');

      // Act
      leader.child.kill('SIGSTOP');
      let other: Awaited<ReturnType<typeof heard>>;
      try {
        await handOver(t, directory.path, coordinator, []);
        run(probe, 'other', 'other');
        await heard(t, probe, 'leading', 'other');
        probe.child.send({ type: 'finish', call: 'other', value: 'served' });
        other = await heard(t, probe, 'value', 'other');
      } finally {
        leader.child.kill('SIGCONT');
      }

      // Assert
      assert.equal(other.value, 'served');
      assert.equal(other.joined, false);
    },
  );
});

describe('A single flight across processes after a flight lands', () => {
  test(
    'a run in another process after the flight landed leads a new flight, and the work runs again',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory('flights-');
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      leader.child.send({ type: 'finish', call: 'l', value: 'first' });
      await heard(t, leader, 'value', 'l');
      await using next = await caller(t, directory.path, 'next');

      // Act
      run(next, 'n', 'sync');
      await heard(t, next, 'leading', 'n');
      next.child.send({ type: 'finish', call: 'n', value: 'second' });
      const second = await heard(t, next, 'value', 'n');

      // Assert
      assert.equal(second.value, 'second');
      assert.equal(second.joined, false);
      assert.deepEqual(
        (await journal(directory.path)).filter((line) =>
          line.endsWith(':sync'),
        ),
        ['leader:work:sync', 'next:work:sync'],
      );
    },
  );
});
