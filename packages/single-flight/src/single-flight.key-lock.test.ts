import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { type Socket, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { SqliteElection } from '@zukhruf/election';

import { callerSource, journalOf } from './testing/caller.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';
import { newProcessTimeout, waitUntil } from './testing/wait-until.ts';
import { type WorkerProcess, startWorker } from './testing/worker-process.ts';

/**
 * Where the processes on `directory` meet their coordinator: a socket file in
 * the directory, or on Windows a named pipe whose name comes from the
 * directory, as this protocol names it.
 */
function socketPathOf(directory: string) {
  if (process.platform !== 'win32') return join(directory, 'flight.sock');
  const id = createHash('sha256')
    .update(resolve(directory).toLowerCase())
    .digest('hex')
    .slice(0, 32);
  return `\\\\.\\pipe\\single-flight-${id}`;
}

/** A caller process on `directory`, ready for orders. */
async function caller(t: TestContext, directory: string, name: string) {
  const worker = startWorker(callerSource(directory), name);
  await waitUntil(
    t,
    () => worker.has('ready'),
    () => worker.stderr,
    newProcessTimeout,
  );
  return worker;
}

/** Runs `key` in `worker` as the call `call`. */
function run(worker: WorkerProcess, call: string, key: string) {
  worker.child.send({ type: 'run', call, key });
}

/** Waits until `worker` reported `type` for `call`, and returns that report. */
async function heard(
  t: TestContext,
  worker: WorkerProcess,
  type: string,
  call: string,
) {
  return firstOf(t, worker, call, [type]);
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
  await waitUntil(
    t,
    () => find() !== undefined,
    () =>
      `No ${types.join(' or ')} for ${call}; got ${JSON.stringify(worker.messages)} ${worker.stderr}`,
    newProcessTimeout,
  );
  const message = find();
  assert.ok(message);
  return message;
}

/** Runs the work of `call` in `worker` to the end with `call` as its value. */
async function lead(t: TestContext, worker: WorkerProcess, call: string) {
  run(worker, call, call);
  await heard(t, worker, 'leading', call);
  worker.child.send({ type: 'finish', call, value: call });
  await heard(t, worker, 'value', call);
}

/**
 * The coordinator, by construction: the first process that makes a call while
 * no other process uses the directory wins the first term.
 */
async function coordinatorOf(t: TestContext, directory: string) {
  const coordinator = await caller(t, directory, 'coordinator');
  await lead(t, coordinator, 'warm-up');
  return coordinator;
}

/**
 * A coordinator served from this test process for the first term, which tells
 * every run to lead and acknowledges every landing, as a coordinator that
 * missed a key's lock would. This package's coordinator makes a run wait while
 * another process holds its key, so only such a coordinator puts a run in the
 * wait for its key's lock in the client. It keeps the requests of each
 * connection, as lines.
 */
async function leadingCoordinator(directory: string) {
  await using serving = new AsyncDisposableStack();
  const term = await new SqliteElection({
    directory,
    claimFile: 'flight.lock',
    epochFile: 'flight.epoch',
  }).campaign();
  assert.ok(term, 'The first campaign in an empty directory must win');
  serving.defer(() => term.resign());
  const connections: string[][] = [];
  const peers = new Set<Socket>();
  let sequence = 0n;
  const server = createServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    const requests: string[] = [];
    connections.push(requests);
    createInterface({ input: peer }).on('line', (line) => {
      requests.push(line);
      const request: unknown = JSON.parse(line);
      if (typeof request !== 'object' || request === null) return;
      if (!('op' in request)) return;
      if (request.op === 'hello') {
        peer.write('{"op":"welcome"}\n');
        return;
      }
      if (!('id' in request) || typeof request.id !== 'string') return;
      const id = JSON.stringify(request.id);
      if (request.op === 'run' && !('flight' in request)) {
        const token = (term.epoch << 32n) | ++sequence;
        peer.write(`{"op":"lead","id":${id},"token":"${token}"}\n`);
      }
      if (request.op === 'land') peer.write(`{"op":"ack","id":${id}}\n`);
    });
  });
  serving.defer(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(socketPathOf(directory));
  await once(server, 'listening');
  const served = serving.move();
  return {
    connections,
    [Symbol.asyncDispose]: () => served.disposeAsync(),
  };
}

/**
 * Runs `sync` in `worker` as `call`, and returns once its lead answer was
 * read, so the run waits for the key's lock: the answers of one connection
 * are read in order, and a run of another key, sent after it, leads later.
 */
async function waitsForKey(
  t: TestContext,
  worker: WorkerProcess,
  call: string,
) {
  run(worker, call, 'sync');
  await heard(t, worker, 'called', call);
  await lead(t, worker, `${call}-after`);
}

/** The id under which `requests` ran `key`. */
function idOfRun(requests: readonly string[], key: string) {
  const pattern = new RegExp(
    `^\\{"op":"run","id":("[^"]+"),"key":${JSON.stringify(key)}\\}$`,
  );
  const id = requests
    .map((line) => pattern.exec(line)?.[1])
    .find((match) => match !== undefined);
  assert.ok(id, `No run of ${key} in ${JSON.stringify(requests)}`);
  return id;
}

/** The runs of the work of `sync`, as `<process>:work:sync`, in order. */
async function runsOfSync(directory: string) {
  const text = await readFile(journalOf(directory), 'utf8');
  return text.split('\n').filter((line) => line.endsWith(':work:sync'));
}

describe('A single flight across processes while a run waits for its key', () => {
  test(
    'a caller that stops waiting while its run waits for the key cancels that flight, its work never runs, and the key is free once the running work ended',
    { timeout: 30_000 },
    async (t) => {
      // Arrange: the runner is told to lead while the holder's work still runs.
      await using directory = await scratchDirectory();
      await using coordinator = await leadingCoordinator(directory.path);
      await using holder = await caller(t, directory.path, 'holder');
      run(holder, 'l', 'sync');
      await heard(t, holder, 'leading', 'l');
      await using runner = await caller(t, directory.path, 'runner');
      await waitsForKey(t, runner, 'fresh');

      // Act
      runner.child.send({ type: 'cancel', call: 'fresh' });
      const stopped = await firstOf(t, runner, 'fresh', ['error', 'value']);
      const requests = coordinator.connections.find((lines) =>
        lines.some((line) => line.includes('"key":"fresh-after"')),
      );
      assert.ok(requests, 'The runner never reached the coordinator');
      const fresh = idOfRun(requests, 'sync');
      await waitUntil(
        t,
        () => requests.includes(`{"op":"cancel","id":${fresh}}`),
        () => `No cancel of ${fresh}: ${JSON.stringify(requests)}`,
      );
      holder.child.send({ type: 'finish', call: 'l', value: 'first' });
      await heard(t, holder, 'value', 'l');
      await using next = await caller(t, directory.path, 'next');
      run(next, 'n', 'sync');
      const first = await firstOf(t, next, 'n', ['leading', 'error']);
      next.child.send({ type: 'finish', call: 'n', value: 'next' });
      await heard(t, next, 'value', 'n');

      // Assert
      assert.equal(stopped.message, 'cancelled by runner');
      assert.equal(first.type, 'leading', 'The key was not free for a new run');
      assert.deepEqual(await runsOfSync(directory.path), [
        'holder:work:sync',
        'next:work:sync',
      ]);
    },
  );

  test(
    'a single flight disposed while its run waits for the key rejects that run as closed, and the key is free once the running work ended',
    { timeout: 30_000 },
    async (t) => {
      // Arrange: the runner is told to lead while the holder's work still runs.
      await using directory = await scratchDirectory();
      await using _coordinator = await leadingCoordinator(directory.path);
      await using holder = await caller(t, directory.path, 'holder');
      run(holder, 'l', 'sync');
      await heard(t, holder, 'leading', 'l');
      await using runner = await caller(t, directory.path, 'runner');
      await waitsForKey(t, runner, 'fresh');

      // Act
      runner.child.send({ type: 'dispose' });
      const closed = await firstOf(t, runner, 'fresh', ['error', 'value']);
      holder.child.send({ type: 'finish', call: 'l', value: 'first' });
      await heard(t, holder, 'value', 'l');
      await using next = await caller(t, directory.path, 'next');
      run(next, 'n', 'sync');
      const first = await firstOf(t, next, 'n', ['leading', 'error']);
      next.child.send({ type: 'finish', call: 'n', value: 'next' });
      await heard(t, next, 'value', 'n');

      // Assert
      assert.equal(closed.message, 'This single flight is closed.');
      assert.equal(first.type, 'leading', 'The key was not free for a new run');
      assert.deepEqual(await runsOfSync(directory.path), [
        'holder:work:sync',
        'next:work:sync',
      ]);
    },
  );

  test(
    "a run whose key's lock cannot be taken for a file fault rejects with the file error, its flight ends, and the single flight leads the key once the fault is gone",
    { timeout: 30_000 },
    async (t) => {
      // Arrange: platform setup that no operation exposes. A plain file where
      // the folder of the key locks belongs makes every key lock fail.
      await using directory = await scratchDirectory();
      const folder = join(directory.path, 'execution-locks');
      await writeFile(folder, '');
      await using runner = await caller(t, directory.path, 'runner');
      await using other = await caller(t, directory.path, 'other');

      // Act
      run(runner, 'faulty', 'sync');
      const faulty = await firstOf(t, runner, 'faulty', ['error', 'value']);
      run(other, 'again', 'sync');
      const again = await firstOf(t, other, 'again', ['error', 'value']);
      await rm(folder);
      run(runner, 'healed', 'sync');
      const healed = await firstOf(t, runner, 'healed', ['leading', 'error']);
      runner.child.send({ type: 'finish', call: 'healed', value: 'healed' });
      await heard(t, runner, 'value', 'healed');

      // Assert: the second run was not left waiting on the first one's flight.
      assert.match(String(faulty.message), /execution-locks/);
      assert.match(String(again.message), /execution-locks/);
      assert.equal(healed.type, 'leading');
      assert.deepEqual(await runsOfSync(directory.path), ['runner:work:sync']);
    },
  );
});

describe('A single flight across processes when the work of a key ends', () => {
  test(
    'a leader whose work fails frees its key: a run in another process leads a new flight',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using leader = await caller(t, directory.path, 'leader');
      run(leader, 'l', 'sync');
      await heard(t, leader, 'leading', 'l');
      leader.child.send({
        type: 'fail',
        call: 'l',
        message: 'broken',
        code: 'EBROKEN',
      });
      await heard(t, leader, 'error', 'l');
      await using next = await caller(t, directory.path, 'next');

      // Act
      run(next, 'n', 'sync');
      const first = await firstOf(t, next, 'n', ['leading', 'joined']);
      next.child.send({ type: 'finish', call: 'n', value: 'second' });
      const second = await heard(t, next, 'value', 'n');

      // Assert
      assert.equal(first.type, 'leading');
      assert.equal(second.value, 'second');
      assert.deepEqual(await runsOfSync(directory.path), [
        'leader:work:sync',
        'next:work:sync',
      ]);
    },
  );
});

describe('A single flight across processes with keys that are no file names', () => {
  test(
    'a run of a key with slashes, dots and more characters than a file name leads and gets its value',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using worker = await coordinatorOf(t, directory.path);
      const key = `../${'x/'.repeat(200)}`;

      // Act
      run(worker, 'long', key);
      const first = await firstOf(t, worker, 'long', ['leading', 'error']);
      worker.child.send({ type: 'finish', call: 'long', value: 'long' });
      const long = await heard(t, worker, 'value', 'long');

      // Assert
      assert.equal(first.type, 'leading');
      assert.equal(long.value, 'long');
    },
  );
});

describe('A single flight across processes with keys that differ only in case', () => {
  // On a file system that folds case (APFS and NTFS, by default) a key's
  // lock file named after the key would be one file for both keys. On one that
  // keeps case (Linux), these tests pass whatever the naming.
  test(
    'runs of `Sync` and `sync` in two processes both lead while both works run',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using upper = await caller(t, directory.path, 'upper');
      await using lower = await caller(t, directory.path, 'lower');
      run(upper, 'u', 'Sync');
      await heard(t, upper, 'leading', 'u');

      // Act
      run(lower, 'l', 'sync');
      const first = await firstOf(t, lower, 'l', ['leading', 'joined']);
      upper.child.send({ type: 'finish', call: 'u', value: 'upper' });
      lower.child.send({ type: 'finish', call: 'l', value: 'lower' });
      const upperValue = await heard(t, upper, 'value', 'u');
      const lowerValue = await heard(t, lower, 'value', 'l');

      // Assert
      assert.equal(first.type, 'leading');
      assert.equal(upperValue.value, 'upper');
      assert.equal(lowerValue.value, 'lower');
    },
  );

  test(
    'a run of `Sync` made while the work of `sync` runs in the same process leads at once',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using worker = await coordinatorOf(t, directory.path);
      run(worker, 'outer', 'sync');
      await heard(t, worker, 'leading', 'outer');

      // Act: the work of `sync` waits for the run of `Sync`, as a nested call would.
      run(worker, 'inner', 'Sync');
      const first = await firstOf(t, worker, 'inner', ['leading', 'joined']);
      worker.child.send({ type: 'finish', call: 'inner', value: 'inner' });
      const inner = await heard(t, worker, 'value', 'inner');
      worker.child.send({ type: 'finish', call: 'outer', value: 'outer' });
      const outer = await heard(t, worker, 'value', 'outer');

      // Assert
      assert.equal(first.type, 'leading');
      assert.equal(inner.value, 'inner');
      assert.equal(outer.value, 'outer');
    },
  );
});
