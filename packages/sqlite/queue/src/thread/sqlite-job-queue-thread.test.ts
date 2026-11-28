import { AssertionError } from 'node:assert';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { type Clock, TestClock, systemClock } from 'pg-boss';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { it } from '@zukhruf/parameterized-test';
import { open, sqliteResultCode } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';

import {
  DatabaseError,
  type JobQueue,
  SqliteJobQueue,
  SqliteJobQueueWarning,
  UnsupportedStartAfterError,
} from '../index.ts';
import { SqliteJobQueueThread } from './index.ts';

/** What a caller reads of a thrown value: its class, its text and its own fields. */
function seen(thrown: unknown) {
  if (!Error.isError(thrown)) return { value: thrown };
  const fields = Object.fromEntries(
    Object.getOwnPropertyNames(thrown)
      .filter((key) => key !== 'stack')
      .map((key) => [key, Reflect.get(thrown, key)]),
  );
  return {
    class: thrown.constructor.name,
    name: thrown.name,
    message: thrown.message,
    fields,
    resultCode: sqliteResultCode(thrown),
  };
}

/**
 * Runs `scenario` in a host process of its own, from a file: a host started
 * with --eval cannot start a thread of a file, since the thread inherits its
 * --input-type. The scenario sends its report over the IPC channel.
 */
async function startHost(
  dir: string,
  scenario: string,
  execArgv: string[] = [],
) {
  const file = join(dir, 'host.mjs');
  await writeFile(
    file,
    `
      import { mkdir, rm } from 'node:fs/promises';
      import { join } from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      import { TestClock } from ${JSON.stringify(import.meta.resolve('pg-boss'))};
      import { SqliteJobQueueThread } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const dir = ${JSON.stringify(dir)};
      const outcome = (promise) => promise.then(
        (value) => ({ value }),
        (error) => ({ name: error.name, message: error.message }),
      );
      ${scenario}
      process.disconnect();
    `,
  );
  const child = fork(file, [], {
    execArgv,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', resolve),
  );
  return Object.assign(child, {
    async report(signal: AbortSignal): Promise<unknown> {
      const [message]: unknown[] = await untilAborted(
        once(child, 'message'),
        signal,
      );
      return message;
    },
    /** How the host exited by itself, and what it wrote to stderr. */
    async ended(signal: AbortSignal) {
      return { code: await untilAborted(exited, signal), stderr };
    },
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  });
}

describe('SqliteJobQueueThread', () => {
  // #4984: node:sqlite is synchronous, so on the main thread a send that
  // waits for the write lock (open.ts busy_timeout) stops every timer of the
  // host until the lock frees.
  it("keeps the host's timers on time while a send waits for another connection's write lock", async (t) => {
    // Arrange: the test's own connection holds the write lock.
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    await using queue = new SqliteJobQueueThread({
      path,
      schedule: false,
      supervise: false,
    });
    await queue.start();
    await queue.createQueue('jobs');
    const holder = open(path);
    let latest = performance.now();
    let worstDrift = 0;
    const interval = setInterval(() => {
      const now = performance.now();
      worstDrift = Math.max(worstDrift, now - latest - 50);
      latest = now;
    }, 50);
    try {
      holder.exec('BEGIN IMMEDIATE');

      // Act: the send waits for the lock, which frees after 2 s.
      const sent = queue.send('jobs', { n: 1 });
      await delay(2000);
      holder.exec('COMMIT');
      const id = await untilAborted(sent, t.signal);

      // Assert
      assert.ok(
        worstDrift < 100,
        `A 50 ms timer of the host ran ${Math.round(worstDrift)} ms late`,
      );
      const [job] = await queue.findJobs('jobs', { id: id ?? '' });
      assert.deepEqual(job?.data, { n: 1 });
    } finally {
      clearInterval(interval);
      holder.close();
    }
  });

  describe('when its thread runs out of memory', () => {
    // A thread with a small heap gets a send larger than the heap, so it
    // ends while the send is in flight. V8's flags are the process's, so a
    // --max-old-space-size in NODE_OPTIONS overrides every thread's
    // resourceLimits: the host runs in a process whose own flag unsets it.
    const host = (dir: string, scenario: string) =>
      startHost(
        dir,
        `
          const errors = [];
          const tooLarge = { items: Array.from({ length: 4_000_000 }, (_, i) => ({ i })) };
          const small = { resourceLimits: { maxOldGenerationSizeMb: 32 } };
          ${scenario}
        `,
        ['--max-old-space-size=0'],
      );
    const queueOn = (clock = '') => `
      const queue = new SqliteJobQueueThread({
        path: join(dir, 'db', 'queue.db'),
        schedule: false,
        supervise: false,
        useListenNotify: true,
        ...small,
        ${clock}
      });
      queue.on('error', (error) => errors.push(error.code ?? error.name));
      await mkdir(join(dir, 'db'));
      await queue.start();
    `;

    it('rejects the call in flight with ConnectionLostError, reports the end, and does not send the call again', async (t) => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');

      // Act
      await using child = await host(
        dir.path,
        `
          ${queueOn()}
          await queue.createQueue('jobs');
          const lost = await outcome(queue.send('jobs', tooLarge));
          // The next call waits for the new thread, which a send sent again would reach first.
          await queue.send('jobs', { n: 2 });
          const after = await queue.findJobs('jobs');
          process.send({ lost, jobs: after.map((job) => job.data), errors });
          await queue[Symbol.asyncDispose]();
        `,
      );
      const report = await child.report(t.signal);

      // Assert
      assert.deepEqual(report, {
        lost: {
          name: 'ConnectionLostError',
          message: 'The connection was lost before the call was answered.',
        },
        jobs: [{ n: 2 }],
        errors: ['ERR_WORKER_OUT_OF_MEMORY'],
      });
    });

    it('starts a new thread that registers each work() of the lost one again, fetches at once, listens again and maps the ids of work()', async (t) => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');

      // Act: two workers on notify queues poll once an hour, so only a fetch
      // at the restart, or a notification, reaches them in the test.
      await using child = await host(
        dir.path,
        `
          ${queueOn()}
          await queue.createQueue('a', { notify: true });
          await queue.createQueue('b', { notify: true });
          const handled = [];
          const arrived = (expected) => new Promise((resolve) => {
            const check = setInterval(() => {
              if (handled.length >= expected) { clearInterval(check); resolve(); }
            }, 20);
          });
          const work = (name) => queue.work(name, { pollingIntervalSeconds: 3600 }, async ([job]) => {
            handled.push(name + ':' + job.data.n);
          });
          await work('a');
          const b = await work('b');
          // Due after the restart's wait of 1 s: only the restart's fetch finds it.
          await queue.send('b', { n: 1 }, { startAfter: 1 });
          await outcome(queue.send('a', tooLarge));
          const next = await outcome(queue.send('a', { n: 2 }));
          await arrived(2);
          await queue.offWork('b', { id: b });
          await queue.send('b', { n: 3 });
          await queue.send('a', { n: 4 });
          await arrived(3);
          const [b3] = await queue.findJobs('b', { data: { n: 3 } });
          process.send({ next: typeof next.value, handled: handled.toSorted(), b3: b3?.state });
          await queue[Symbol.asyncDispose]();
        `,
      );
      const report = await child.report(t.signal);

      // Assert
      assert.deepEqual(report, {
        next: 'string',
        handled: ['a:2', 'a:4', 'b:1'],
        b3: 'created',
      });
    });

    it("waits 1 s, doubling up to 30 s, on the queue's clock before each attempt, gives each failed attempt to 'error' and to the calls that waited for it", async (t) => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');

      // Act: the file's folder is gone, so each attempt fails to open it,
      // until the folder comes back.
      await using child = await host(
        dir.path,
        `
          const clock = new TestClock('2026-01-01T00:00:00.000Z');
          ${queueOn('clock,')}
          await queue.createQueue('jobs');
          await outcome(queue.send('jobs', tooLarge));
          await rm(join(dir, 'db'), { recursive: true });
          const waiting = outcome(queue.send('jobs', { n: 1 }));
          const failed = () => errors.filter((code) => code === 'MissingError').length;
          // An attempt takes real time to fail: a thread starts and opens the file.
          // An early attempt would fail within the shorter wait.
          const attempted = async (count, budget) => {
            for (let waited = 0; waited < budget && failed() < count; waited += 20) await delay(20);
            return failed() >= count;
          };
          const waits = [];
          for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
            const count = failed();
            await clock.tick(ms - 1);
            const early = await attempted(count + 1, 500);
            await clock.tick(1);
            waits.push({ ms, early, due: await attempted(count + 1, 30000) });
          }
          await mkdir(join(dir, 'db'));
          // The folder is new, so the file has no queue yet.
          const later = outcome(queue.getQueues());
          await clock.tick(30000);
          process.send({
            waits,
            waiting: await waiting,
            later: await later,
          });
          await queue[Symbol.asyncDispose]();
        `,
      );
      const report = await child.report(t.signal);

      // Assert
      const waits = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      assert.deepEqual(report, {
        waits: waits.map((ms) => ({ ms, early: false, due: true })),
        waiting: {
          name: 'MissingError',
          message: `The database at ${JSON.stringify(join(dir.path, 'db', 'queue.db'))} cannot be opened: the file, or a folder on its path, is not there. Check the path, or make the database first.`,
        },
        later: { value: [] },
      });
    });
  });

  describe('gives each error of the engine as the main thread gives it', () => {
    void it.each(
      [
        {
          error: 'an AssertionError of a bad argument',
          kind: AssertionError,
          act: (queue: JobQueue) => queue.fetch('jobs', { batchSize: 0 }),
        },
        {
          error: 'a DatabaseError with its code',
          kind: DatabaseError,
          act: (queue: JobQueue) =>
            queue.send('jobs', null, { id: 'not a uuid' }),
        },
        {
          error: 'an UnsupportedStartAfterError with its startAfter',
          kind: UnsupportedStartAfterError,
          act: (queue: JobQueue) =>
            queue.send('jobs', null, { startAfter: 'next tuesday' }),
        },
        {
          error: "node:sqlite's error with its errcode and errstr",
          kind: Error,
          drop: true,
          act: (queue: JobQueue) => queue.send('jobs', null),
        },
      ],
      ({ error, kind, drop = false, act }) =>
        it(`${error}`, async (t) => {
          // Arrange: one queue of each form, each on its own file.
          await using dir = await new TemporaryFiles().directory(
            'sqlite-queue-',
          );
          const onFile = async (name: string, queue: JobQueue) => {
            await queue.start();
            await queue.createQueue('jobs');
            if (drop) {
              using own = open(join(dir.path, name));
              own.exec('DROP TABLE pgboss_job');
            }
            return queue;
          };
          const options = { schedule: false, supervise: false } as const;
          const main = await onFile(
            'main.db',
            new SqliteJobQueue({ ...options, path: join(dir.path, 'main.db') }),
          );
          await using thread = new SqliteJobQueueThread({
            ...options,
            path: join(dir.path, 'thread.db'),
          });
          await onFile('thread.db', thread);
          try {
            // Act
            const onMain: unknown = await act(main).catch(
              (thrown: unknown) => thrown,
            );
            const onThread: unknown = await untilAborted<unknown>(
              act(thread),
              t.signal,
            ).catch((thrown: unknown) => thrown);

            // Assert
            assert.ok(onMain instanceof kind, String(onMain));
            assert.ok(onThread instanceof kind, String(onThread));
            assert.ok(Error.isError(onThread), 'It must be a native error');
            if (drop) {
              assert.equal(sqliteResultCode(onThread)?.code, 1, 'SQLITE_ERROR');
            }
            assert.deepEqual(seen(onThread), seen(onMain));
          } finally {
            await main.stop();
          }
        }),
    );
  });

  void it.each(
    [
      {
        claim: 'aborts the signal, with the reason of the engine',
        reasonOf: (reason: unknown) => ({
          message: Reflect.get(Object(reason), 'message'),
        }),
        expected: { message: 'This operation was aborted' },
      },
      {
        claim:
          'gives the reason as the DOMException named AbortError that the main thread gives',
        reasonOf: (reason: unknown) => ({
          domException: reason instanceof DOMException,
          name: Reflect.get(Object(reason), 'name'),
        }),
        expected: { domException: true, name: 'AbortError' },
      },
    ],
    ({ claim, reasonOf, expected }) =>
      it(`when the engine gives up on a job, ${claim}`, async (t) => {
        // Arrange: the job may run for a second of the clock.
        await using dir = await new TemporaryFiles().directory('sqlite-queue-');
        const clock = new TestClock('2026-01-01T00:00:00.000Z');
        await using queue = new SqliteJobQueueThread({
          path: join(dir.path, 'queue.db'),
          schedule: false,
          supervise: false,
          clock,
        });
        await queue.start();
        await queue.createQueue('jobs');
        await queue.send('jobs', null, { expireInSeconds: 1 });
        const running = Promise.withResolvers<AbortSignal>();
        await queue.work('jobs', ([job]) => {
          if (job) running.resolve(job.signal);
          return new Promise<void>((resolve) =>
            job?.signal.addEventListener('abort', () => resolve()),
          );
        });
        const signal = await untilAborted(running.promise, t.signal);
        const beforeExpiry = signal.aborted;

        // Act
        await clock.tick(1000);
        await waitFor(() => assert.ok(signal.aborted), { signal: t.signal });

        // Assert
        assert.equal(beforeExpiry, false);
        assert.deepEqual(reasonOf(signal.reason), expected);
      }),
  );

  it('goes on after a call with a value that the port cannot clone', async (t) => {
    // Arrange
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    await using queue = new SqliteJobQueueThread({
      path: join(dir.path, 'queue.db'),
      schedule: false,
      supervise: false,
    });
    await queue.start();
    await queue.createQueue('jobs');

    // Act: the structured clone refuses a WeakMap.
    const refused = untilAborted(
      queue.send('jobs', { map: new WeakMap() }),
      t.signal,
    );
    await assert.rejects(refused, Error);
    const next = await untilAborted(queue.send('jobs', { n: 2 }), t.signal);

    // Assert
    const jobs = await untilAborted(queue.findJobs('jobs'), t.signal);
    assert.deepEqual(
      jobs.map((job) => ({ id: job.id, data: job.data })),
      [{ id: next, data: { n: 2 } }],
    );
  });

  describe('on a clock', () => {
    it("of pg-boss's TestClock, settles each tick across the thread and stamps the jobs with the clock's time", async (t) => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');
      const clock = new TestClock('2026-01-01T00:00:00.000Z');
      await using queue = new SqliteJobQueueThread({
        path: join(dir.path, 'queue.db'),
        schedule: false,
        supervise: false,
        clock,
      });
      await queue.start();
      await queue.createQueue('jobs');
      const handled: unknown[] = [];
      await queue.work('jobs', { pollingIntervalSeconds: 1 }, async ([job]) => {
        handled.push(job?.data);
      });
      await clock.tick(500);
      const id = await queue.send('jobs', { n: 1 });

      // Act: the poll is due within the second.
      await clock.tick(1000);

      // Assert: what the tick fired has finished when the tick returns.
      assert.deepEqual(handled, [{ n: 1 }]);
      const [job] = await untilAborted(
        queue.findJobs('jobs', { id: id ?? '' }),
        t.signal,
      );
      assert.deepEqual(
        { state: job?.state, createdOn: job?.createdOn.toISOString() },
        { state: 'completed', createdOn: '2026-01-01T00:00:00.500Z' },
      );
    });

    it('that is not systemClock, arms every timer of the engine on it and leaves none armed after the dispose', async () => {
      // Arrange: a clock over the system's timers that counts what is armed.
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');
      const armed = new Set<unknown>();
      const clock: Clock = {
        now: () => Date.now(),
        setTimeout: (callback, ms) => {
          const timer = setTimeout(() => {
            armed.delete(timer);
            callback();
          }, ms);
          armed.add(timer);
          return timer;
        },
        clearTimeout: (timer) => {
          armed.delete(timer);
          systemClock.clearTimeout(timer);
        },
        setInterval: (callback, ms) => {
          const timer = setInterval(callback, ms);
          armed.add(timer);
          return timer;
        },
        clearInterval: (timer) => {
          armed.delete(timer);
          systemClock.clearInterval(timer);
        },
      };
      const queue = new SqliteJobQueueThread({
        path: join(dir.path, 'queue.db'),
        schedule: false,
        supervise: false,
        clock,
      });

      // Act
      await queue.start();
      await queue.createQueue('jobs');
      await queue.work('jobs', async () => {});
      const whileRunning = armed.size;
      await queue[Symbol.asyncDispose]();

      // Assert
      assert.ok(
        whileRunning > 0,
        'The engine must arm its timers on the clock',
      );
      assert.equal(armed.size, 0);
    });

    it("of systemClock, leaves the engine's timers in its thread", async () => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');
      const timeouts = () =>
        process
          .getActiveResourcesInfo()
          .filter((resource) => resource === 'Timeout').length;
      const before = timeouts();
      await using queue = new SqliteJobQueueThread({
        path: join(dir.path, 'queue.db'),
        schedule: false,
        supervise: false,
        clock: systemClock,
      });

      // Act
      await queue.start();
      await queue.createQueue('jobs');
      await queue.work('jobs', async () => {});

      // Assert
      assert.equal(timeouts(), before);
    });
  });

  // The engine reacts to an 'error' that nobody hears: a stop that fails to
  // fail a worker's jobs then warns the process (index.ts #failWip). The
  // thread hears the engine's 'error' only while the host has a listener.
  describe("follows the host's 'error' listeners", () => {
    void it.each(
      [
        { listeners: 'none', hears: 'a process warning' },
        { listeners: 'one added after the start', hears: "an 'error' event" },
        {
          listeners: 'one removed after the start',
          hears: 'a process warning',
        },
      ] as const,
      ({ listeners, hears }) =>
        it(`with ${listeners}, a stop that fails to fail a worker's jobs gives ${hears}`, async (t) => {
          // Arrange: the queue is deleted under the worker's running job, so
          // the stop's fail of that job finds no queue.
          await using dir = await new TemporaryFiles().directory(
            'sqlite-queue-',
          );
          const warnings: Error[] = [];
          const onWarning = (warning: Error) => {
            if (warning.name === 'SqliteJobQueueWarning')
              warnings.push(warning);
          };
          const errors: unknown[] = [];
          const heard = Promise.withResolvers<void>();
          const onError = (error: unknown) => {
            errors.push(error);
            heard.resolve();
          };
          process.on('warning', onWarning);
          const release = Promise.withResolvers<void>();
          await using queue = new SqliteJobQueueThread({
            path: join(dir.path, 'queue.db'),
            schedule: false,
            supervise: false,
          });
          try {
            if (listeners === 'one removed after the start') {
              queue.on('error', onError);
            }
            await queue.start();
            if (listeners === 'one added after the start') {
              queue.on('error', onError);
            }
            if (listeners === 'one removed after the start') {
              queue.off('error', onError);
            }
            await queue.createQueue('jobs');
            await queue.send('jobs', { n: 1 });
            const started = Promise.withResolvers<void>();
            const worker = await queue.work('jobs', async () => {
              started.resolve();
              await release.promise;
            });
            await untilAborted(started.promise, t.signal);
            await queue.deleteQueue('jobs');

            // Act
            await queue.stop({ graceful: false, close: false });
            if (hears === "an 'error' event") {
              await untilAborted(heard.promise, t.signal);
            } else {
              await waitFor(() => assert.notEqual(warnings.length, 0), {
                signal: t.signal,
              });
            }

            // Assert
            if (hears === 'a process warning') {
              const [warning] = warnings;
              assert.deepEqual(errors, []);
              assert.ok(warning instanceof SqliteJobQueueWarning);
              assert.deepEqual(
                { ...warning, message: warning.message },
                {
                  name: 'SqliteJobQueueWarning',
                  code: 'ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD',
                  detail: `queue: jobs\nworker: ${worker}`,
                  message:
                    "The fail of a worker's active jobs at stop failed, and nobody listens for 'error': Queue jobs does not exist",
                },
              );
            } else {
              assert.deepEqual(warnings, []);
              // The stop's error comes first; the worker's poll of the
              // deleted queue may fail after it.
              const [first] = errors;
              assert.deepEqual(
                {
                  message: Reflect.get(Object(first), 'message'),
                  queue: Reflect.get(Object(first), 'queue'),
                  worker: Reflect.get(Object(first), 'worker'),
                },
                { message: 'Queue jobs does not exist', queue: 'jobs', worker },
              );
            }
          } finally {
            release.resolve();
            process.off('warning', onWarning);
          }
        }),
    );
  });

  describe('in a host process', () => {
    it('rejects a start that cannot open the file, leaves no thread, and refuses the next call', async (t) => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');

      // Act
      await using child = await startHost(
        dir.path,
        `
          const queue = new SqliteJobQueueThread({ path: join(dir, 'missing', 'queue.db') });
          const start = await outcome(queue.start());
          const send = await outcome(queue.send('jobs', null));
          process.send({ start: start.name, send });
        `,
      );
      const report = await child.report(t.signal);
      const ended = await child.ended(t.signal);

      // Assert
      assert.deepEqual(report, {
        start: 'MissingError',
        send: {
          name: 'AssertionError',
          message:
            'Database not opened. Call start() before using pg-boss, or again after stop().',
        },
      });
      assert.deepEqual(ended, { code: 0, stderr: '' });
    });

    it('exits by itself once the queue is disposed, with its thread ended and not started again', async (t) => {
      // Arrange
      await using dir = await new TemporaryFiles().directory('sqlite-queue-');

      // Act
      await using child = await startHost(
        dir.path,
        `
          const queue = new SqliteJobQueueThread({ path: join(dir, 'queue.db') });
          await queue.start();
          await queue.createQueue('jobs');
          const handled = Promise.withResolvers();
          await queue.work('jobs', { pollingIntervalSeconds: 0.5 }, async ([job]) => handled.resolve(job.data));
          await queue.send('jobs', { n: 1 });
          const data = await handled.promise;
          await queue[Symbol.asyncDispose]();
          process.send({ data });
        `,
      );
      const report = await child.report(t.signal);
      const ended = await child.ended(t.signal);

      // Assert
      assert.deepEqual(report, { data: { n: 1 } });
      assert.deepEqual(ended, { code: 0, stderr: '' });
    });

    void it.each(
      [
        { flags: [], printed: 1, times: 'once' },
        { flags: ['--no-warnings'], printed: 0, times: 'never' },
      ],
      ({ flags, printed, times }) =>
        it(`prints a warning of the thread ${times} under the host's flags ${JSON.stringify(flags)}`, async (t) => {
          // Arrange
          await using dir = await new TemporaryFiles().directory(
            'sqlite-queue-',
          );

          // Act: a stop fails to fail a worker's job, and nobody listens for
          // 'error', so the engine warns its process.
          await using child = await startHost(
            dir.path,
            `
              const queue = new SqliteJobQueueThread({ path: join(dir, 'queue.db'), schedule: false, supervise: false });
              const warned = Promise.withResolvers();
              process.on('warning', (warning) => {
                if (warning.name === 'SqliteJobQueueWarning') warned.resolve();
              });
              await queue.start();
              await queue.createQueue('jobs');
              await queue.send('jobs', { n: 1 });
              const started = Promise.withResolvers();
              const release = Promise.withResolvers();
              await queue.work('jobs', async () => {
                started.resolve();
                await release.promise;
              });
              await started.promise;
              await queue.deleteQueue('jobs');
              await queue.stop({ graceful: false, close: false });
              await warned.promise;
              release.resolve();
              await queue[Symbol.asyncDispose]();
              process.send({ warned: true });
            `,
            flags,
          );
          await child.report(t.signal);
          const { stderr } = await child.ended(t.signal);

          // Assert
          assert.equal(
            stderr.split('SqliteJobQueueWarning').length - 1,
            printed,
            stderr,
          );
        }),
    );
  });
});
