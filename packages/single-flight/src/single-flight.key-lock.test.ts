import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { callerSource, journalOf } from './testing/caller.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';
import { newProcessTimeout, waitUntil } from './testing/wait-until.ts';
import { type WorkerProcess, startWorker } from './testing/worker-process.ts';

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
 * A process whose work of `sync` runs on after it disposed its single flight.
 * The coordinator drops the flight of a closed connection at once, so the
 * next run of `sync` is told to lead while this work still runs.
 */
async function disposedLeader(t: TestContext, directory: string) {
  const holder = await caller(t, directory, 'holder');
  run(holder, 'l', 'sync');
  await heard(t, holder, 'leading', 'l');
  holder.child.send({ type: 'dispose' });
  await waitUntil(
    t,
    () => holder.has('disposed'),
    () => holder.stderr,
    newProcessTimeout,
  );
  return holder;
}

/**
 * Runs `sync` in `worker` as `call`, and returns once the coordinator
 * answered it: the coordinator decides one connection's requests in order, so
 * a run of another key sent after it has its answer later.
 */
async function answered(t: TestContext, worker: WorkerProcess, call: string) {
  run(worker, call, 'sync');
  await heard(t, worker, 'called', call);
  await lead(t, worker, `${call}-after`);
}

/** The runs of the work of `sync`, as `<process>:work:sync`, in order. */
async function runsOfSync(directory: string) {
  const text = await readFile(journalOf(directory), 'utf8');
  return text.split('\n').filter((line) => line.endsWith(':work:sync'));
}

describe('A single flight across processes while a run waits for its key', () => {
  test(
    'a caller that stops waiting while its run waits for the key ends that flight: its joiner gets FlightInterruptedError, its work never runs, and the key is free once the running work ended',
    { timeout: 30_000 },
    async (t) => {
      // Arrange: the runner is told to lead while the holder's work still runs, and the joiner joins its flight.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using holder = await disposedLeader(t, directory.path);
      await using runner = await caller(t, directory.path, 'runner');
      await answered(t, runner, 'fresh');
      await using joiner = await caller(t, directory.path, 'joiner');
      run(joiner, 'j', 'sync');
      await heard(t, joiner, 'joined', 'j');

      // Act
      runner.child.send({ type: 'cancel', call: 'fresh' });
      const stopped = await firstOf(t, runner, 'fresh', ['error', 'value']);
      const interrupted = await firstOf(t, joiner, 'j', ['error', 'value']);
      holder.child.send({ type: 'finish', call: 'l', value: 'unheard' });
      await heard(t, holder, 'value', 'l');
      run(joiner, 'next', 'sync');
      const next = await firstOf(t, joiner, 'next', ['leading', 'joined']);
      joiner.child.send({ type: 'finish', call: 'next', value: 'next' });
      await heard(t, joiner, 'value', 'next');

      // Assert
      assert.equal(stopped.message, 'cancelled by runner');
      assert.equal(interrupted.name, 'FlightInterruptedError');
      assert.equal(next.type, 'leading', 'The key was not free for a new run');
      assert.deepEqual(await runsOfSync(directory.path), [
        'holder:work:sync',
        'joiner:work:sync',
      ]);
    },
  );

  test(
    'a single flight disposed while its run waits for the key rejects that run as closed, and the key is free once the running work ended',
    { timeout: 30_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(t, directory.path);
      await using holder = await disposedLeader(t, directory.path);
      await using runner = await caller(t, directory.path, 'runner');
      await answered(t, runner, 'fresh');

      // Act
      runner.child.send({ type: 'dispose' });
      const closed = await firstOf(t, runner, 'fresh', ['error', 'value']);
      holder.child.send({ type: 'finish', call: 'l', value: 'unheard' });
      await heard(t, holder, 'value', 'l');
      await using next = await caller(t, directory.path, 'next');
      run(next, 'n', 'sync');
      const first = await firstOf(t, next, 'n', ['leading', 'joined']);
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
