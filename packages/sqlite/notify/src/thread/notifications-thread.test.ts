import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { createClock } from '@sinonjs/fake-timers';

import { type Clock, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { it } from '@zukhruf/parameterized-test';
import { ServerWarning } from '@zukhruf/rpc';
import { open, sqliteResultCode } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';

import {
  DisposedError,
  MissingError,
  Notifications,
  QueueFullError,
} from '../index.ts';
import { addressesOf, hear, startProgram } from '../testing/program.ts';
import { NotificationsThread } from './index.ts';
import { errors } from './protocol.ts';

/** A form of the notifications: the main thread's, or the thread's. */
interface Form {
  readonly name: string;
  make(options: {
    path: string;
    clock: Clock;
    maxQueuedNotifications?: number;
  }): Promise<Notifications | NotificationsThread>;
}

const forms: readonly Form[] = [
  { name: 'main thread', make: async (options) => new Notifications(options) },
  { name: 'thread', make: (options) => NotificationsThread.create(options) },
];

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
 * The worker threads that start while it is held. Nothing a caller does ends
 * a thread, so a test that needs a lost thread ends it with
 * `Worker.terminate()`, as a crash of the thread would end it.
 */
function watchThreads() {
  const workers: Worker[] = [];
  const record = (message: unknown) => {
    const worker = Reflect.get(Object(message), 'worker');
    if (worker instanceof Worker) workers.push(worker);
  };
  subscribe('worker_threads', record);
  return {
    workers,
    [Symbol.dispose]() {
      unsubscribe('worker_threads', record);
    },
  };
}

/**
 * Runs `scenario` in a host process of its own, from a file: a host started
 * with --eval cannot start a thread of a file, since the thread inherits its
 * --input-type. The scenario sends its report over the IPC channel.
 */
async function startHost(dir: string, scenario: string) {
  const file = join(dir, 'host.mjs');
  await writeFile(
    file,
    `
      import { join } from 'node:path';
      import { Notifications } from ${JSON.stringify(new URL('../index.ts', import.meta.url).href)};
      import { NotificationsThread } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const dir = ${JSON.stringify(dir)};
      const outcome = (promise) => promise.then(
        (value) => ({ value }),
        (error) => ({ name: error.name, message: error.message }),
      );
      ${scenario}
      process.disconnect();
    `,
  );
  const child = fork(file, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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

describe('NotificationsThread', () => {
  // #4984: node:sqlite is synchronous, so on the main thread a notify that
  // waits for the write lock (open.ts busy_timeout) stops every timer of the
  // host until the lock frees.
  it("keeps the host's timers on time while a notify waits for another connection's write lock", async (t) => {
    // Arrange: the test's own connection holds the write lock.
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    await using notifications = await NotificationsThread.create({
      path,
      clock: globalThis,
    });
    const heard = hear(notifications);
    await notifications.listen('jobs');
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

      // Act: the notify waits for the lock, which frees after 2 s.
      const sent = notifications.notify('jobs', 'email');
      await delay(2000);
      holder.exec('COMMIT');
      await untilAborted(sent, t.signal);

      // Assert
      assert.ok(
        worstDrift < 100,
        `A 50 ms timer of the host ran ${Math.round(worstDrift)} ms late`,
      );
      assert.deepEqual(await heard.count(1, { signal: t.signal }), [
        { processId: process.pid, channel: 'jobs', payload: 'email' },
      ]);
    } finally {
      clearInterval(interval);
      holder.close();
    }
  });

  describe('when its thread ends', () => {
    it('rejects the call in flight with ConnectionLostError and does not send it again', async (t) => {
      // Arrange: the lock keeps the notify from committing until the thread is gone.
      await using folder = await new TemporaryFiles().directory('notify-');
      const path = join(folder.path, 'app.sqlite');
      const clock = createClock();
      using threads = watchThreads();
      await using notifications = await NotificationsThread.create({
        path,
        clock,
      });
      await using listener = await startProgram(path, { signal: t.signal });
      listener.do({ do: 'listen', channel: 'jobs' });
      await listener.printedOne((p) => p.event === 'listened');
      const holder = open(path);
      try {
        holder.exec('BEGIN IMMEDIATE');

        // Act
        const lost = notifications.notify('jobs', 'lost');
        const [thread] = threads.workers;
        assert.ok(thread);
        void thread.terminate();
        const outcome: unknown = await untilAborted(lost, t.signal).catch(
          (error: unknown) => error,
        );
        holder.exec('COMMIT');
        await clock.tickAsync(1000);
        // The next call waits for the new thread, which a notify sent again would reach first.
        await untilAborted(notifications.notify('jobs', 'next'), t.signal);

        // Assert
        assert.deepEqual(
          { name: Reflect.get(Object(outcome), 'name') },
          { name: 'ConnectionLostError' },
        );
        assert.deepEqual(
          (await listener.heard(1)).map((n) => n.payload),
          ['next'],
        );
      } finally {
        if (holder.isTransaction) holder.exec('COMMIT');
        holder.close();
      }
    });

    it('starts a new thread 1 s later on its clock that listens again on each channel, and misses the notifications of the gap', async (t) => {
      // Arrange
      await using folder = await new TemporaryFiles().directory('notify-');
      const path = join(folder.path, 'app.sqlite');
      const clock = createClock();
      using threads = watchThreads();
      await using notifications = await NotificationsThread.create({
        path,
        clock,
      });
      const heard = hear(notifications);
      for (const channel of ['a', 'b', 'left']) {
        await notifications.listen(channel);
      }
      await notifications.unlisten('left');
      await using sender = await startProgram(path, { signal: t.signal });
      const [thread] = threads.workers;
      assert.ok(thread);

      // Act
      await thread.terminate();
      sender.do({ do: 'notify', channel: 'a', payloads: ['in the gap'] });
      await sender.printedOne((p) => p.event === 'sent');
      await clock.tickAsync(999);
      const early = threads.workers.length;
      await clock.tickAsync(1);
      // A call during the restart waits for the new thread and its listens.
      await untilAborted(notifications.notify('a', 'own'), t.signal);
      for (const channel of ['a', 'b', 'left']) {
        sender.do({ do: 'notify', channel, payloads: [`to ${channel}`] });
      }
      await notifications.listen('marker');
      sender.do({ do: 'notify', channel: 'marker', payloads: ['marker'] });

      // Assert
      assert.equal(early, 1);
      assert.equal(threads.workers.length, 2);
      assert.deepEqual(
        (await heard.count(4, { signal: t.signal })).map((n) => n.payload),
        ['own', 'to a', 'to b', 'marker'],
      );
      assert.deepEqual(heard.errors, []);
    });

    it("waits 1 s, doubling up to 30 s, on its clock before each attempt, gives each failed attempt to 'error' and to the calls that waited for it", async (t) => {
      // Arrange: the file's folder is gone, so each attempt fails to open it,
      // until the folder comes back.
      await using folder = await new TemporaryFiles().directory('notify-');
      const dir = join(folder.path, 'db');
      await mkdir(dir);
      const path = join(dir, 'app.sqlite');
      const clock = createClock();
      using threads = watchThreads();
      await using notifications = await NotificationsThread.create({
        path,
        clock,
      });
      const heard = hear(notifications);
      const [thread] = threads.workers;
      assert.ok(thread);
      await thread.terminate();
      await rm(dir, { recursive: true });
      const failed = () =>
        heard.errors.filter((error) => error instanceof MissingError).length;

      // Act
      const waiting = untilAborted(
        notifications.notify('jobs', 'waits'),
        t.signal,
      ).catch((error: unknown) => error);
      const waits: unknown[] = [];
      for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const spawned = threads.workers.length;
        const count = failed();
        // An attempt spawns its thread in the turn its wait ends.
        await clock.tickAsync(ms - 1);
        await setImmediate();
        const early = threads.workers.length > spawned;
        await clock.tickAsync(1);
        // The next wait starts when the attempt has failed.
        await waitFor(() => assert.equal(failed(), count + 1), {
          signal: t.signal,
        });
        waits.push({ ms, early, due: threads.workers.length === spawned + 1 });
      }
      await mkdir(dir);
      await clock.tickAsync(30000);
      const later = await untilAborted(
        notifications.notify('jobs', 'later'),
        t.signal,
      );

      // Assert
      const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
      assert.deepEqual(
        waits,
        expected.map((ms) => ({ ms, early: false, due: true })),
      );
      assert.ok((await waiting) instanceof MissingError, String(await waiting));
      assert.equal(later, undefined);
    });

    it('waits 1 s again before the restart after a restart that opened the file', async (t) => {
      // Arrange: one failed attempt, then one that opens the file.
      await using folder = await new TemporaryFiles().directory('notify-');
      const dir = join(folder.path, 'db');
      await mkdir(dir);
      const clock = createClock();
      using threads = watchThreads();
      await using notifications = await NotificationsThread.create({
        path: join(dir, 'app.sqlite'),
        clock,
      });
      const heard = hear(notifications);
      await threads.workers.at(-1)?.terminate();
      await rm(dir, { recursive: true });
      await clock.tickAsync(1000);
      await waitFor(() => assert.equal(heard.errors.length, 1), {
        signal: t.signal,
      });
      await mkdir(dir);
      await clock.tickAsync(2000);
      await untilAborted(notifications.notify('jobs', 'opened'), t.signal);
      const spawned = threads.workers.length;

      // Act
      await threads.workers.at(-1)?.terminate();
      await clock.tickAsync(999);
      await setImmediate();
      const early = threads.workers.length;
      await clock.tickAsync(1);
      // An attempt spawns its thread in the turn its wait ends.
      await setImmediate();
      const due = threads.workers.length;

      // Assert
      assert.deepEqual({ early, due }, { early: spawned, due: spawned + 1 });
      await untilAborted(notifications.notify('jobs', 'again'), t.signal);
    });

    it('rejects a call that waits for a restart with DisposedError when the dispose overtakes the restart, and leaves no thread', async (t) => {
      // Arrange
      await using folder = await new TemporaryFiles().directory('notify-');
      const clock = createClock();
      using threads = watchThreads();
      const notifications = await NotificationsThread.create({
        path: join(folder.path, 'app.sqlite'),
        clock,
      });
      await notifications.listen('jobs');
      await threads.workers.at(-1)?.terminate();
      const waiting = untilAborted(
        notifications.notify('jobs', 'waits'),
        t.signal,
      ).catch((error: unknown) => error);

      try {
        // Act: the new thread has started and opens the file.
        await clock.tickAsync(1000);
        const spawned = threads.workers.length;
        await notifications[Symbol.asyncDispose]();

        // Assert
        assert.equal(spawned, 2);
        assert.ok(
          (await waiting) instanceof DisposedError,
          String(await waiting),
        );
        // Node gives an exited thread the id -1.
        assert.deepEqual(
          threads.workers.map((worker) => worker.threadId),
          [-1, -1],
        );
      } finally {
        // A thread that the dispose left would keep the test process alive.
        await Promise.all(threads.workers.map((worker) => worker.terminate()));
      }
    });

    it('does not listen again on a channel whose listen failed', async (t) => {
      // Arrange: the lock outlasts the busy timeout of the listen.
      await using folder = await new TemporaryFiles().directory('notify-');
      const path = join(folder.path, 'app.sqlite');
      const clock = createClock();
      using threads = watchThreads();
      await using notifications = await NotificationsThread.create({
        path,
        clock,
      });
      const heard = hear(notifications);
      await notifications.listen('kept');
      const holder = open(path);
      holder.exec('BEGIN IMMEDIATE');
      let failed: unknown;
      try {
        failed = await untilAborted(
          notifications.listen('jobs'),
          t.signal,
        ).catch((error: unknown) => error);
      } finally {
        holder.exec('COMMIT');
        holder.close();
      }

      // Act: the restart listens again on each wanted channel.
      await threads.workers.at(-1)?.terminate();
      await clock.tickAsync(1000);
      await untilAborted(notifications.notify('jobs', 'unheard'), t.signal);
      await untilAborted(notifications.notify('kept', 'marker'), t.signal);

      // Assert
      assert.equal(sqliteResultCode(failed)?.code, 5, 'SQLITE_BUSY');
      assert.deepEqual(
        (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
        ['marker'],
      );
    });
  });

  describe('gives each error as the main thread gives it', () => {
    void it.each<{
      error: string;
      kind: abstract new (...args: never[]) => Error;
      act: (form: Form, path: string) => Promise<unknown>;
    }>(
      [
        {
          error: 'a QueueFullError with its code',
          kind: QueueFullError,
          act: async (form: Form, path: string) => {
            await using notifications = await form.make({
              path,
              clock: createClock(),
              maxQueuedNotifications: 1,
            });
            // The listener keeps the first row, so the second finds the queue full.
            await notifications.listen('other');
            await notifications.notify('jobs', 'first');
            await notifications.notify('jobs', 'second');
          },
        },
        {
          error: 'a MissingError of a file that cannot be opened',
          kind: MissingError,
          act: (form: Form, path: string) =>
            form.make({
              path: join(path, '..', 'missing', 'app.sqlite'),
              clock: createClock(),
            }),
        },
        {
          error: 'a TypeError of a database in memory',
          kind: TypeError,
          act: (form: Form) =>
            form.make({ path: ':memory:', clock: createClock() }),
        },
        {
          error: "node:sqlite's error with its errcode and errstr",
          kind: Error,
          act: async (form: Form, path: string) => {
            await using notifications = await form.make({
              path,
              clock: createClock(),
            });
            using own = open(path);
            own.exec('DROP TABLE zukhruf_notify_queue');
            await notifications.notify('jobs', 'nowhere');
          },
        },
        {
          error: 'a RangeError of a limit',
          kind: RangeError,
          act: async (form: Form, path: string) => {
            await using notifications = await form.make({
              path,
              clock: createClock(),
            });
            await notifications.notify('');
          },
        },
        {
          error: 'a DisposedError after the dispose',
          kind: DisposedError,
          act: async (form: Form, path: string) => {
            const notifications = await form.make({
              path,
              clock: createClock(),
            });
            await notifications[Symbol.asyncDispose]();
            await notifications.listen('jobs');
          },
        },
      ],
      ({ error, kind, act }) =>
        it(`${error}`, async (t) => {
          // Arrange: one file for each form.
          await using folder = await new TemporaryFiles().directory('notify-');

          // An act that does not throw leaves its notifications to the stack.
          await using made = new AsyncDisposableStack();

          // Act
          const outcomes: unknown[] = [];
          for (const form of forms) {
            const path = join(folder.path, `${form.name}.sqlite`);
            const outcome = await untilAborted<unknown>(
              Promise.try(() => act(form, path)),
              t.signal,
            ).catch((thrown: unknown) => thrown);
            if (
              outcome instanceof Notifications ||
              outcome instanceof NotificationsThread
            )
              made.use(outcome);
            outcomes.push(outcome);
          }

          // Assert
          const [onMain, onThread] = outcomes;
          assert.ok(onMain instanceof kind, String(onMain));
          assert.ok(onThread instanceof kind, String(onThread));
          assert.deepEqual(seen(onThread), seen(onMain));
        }),
    );

    it("gives an error of its listener's read to 'error' with its class and fields", async (t) => {
      // Arrange: a listener of each form, each on its own file and clock.
      await using folder = await new TemporaryFiles().directory('notify-');
      const errors: unknown[] = [];
      for (const form of forms) {
        const path = join(folder.path, `${form.name}.sqlite`);
        const clock = createClock();
        await using notifications = await form.make({ path, clock });
        const heard = hear(notifications);
        await notifications.listen('jobs');
        // The table goes under the listener, which no operation does.
        using own = open(path);
        own.exec('DROP TABLE zukhruf_notify_queue');

        // Act: the backstop finds the file changed and reads the queue.
        await clock.tickAsync(1000);
        await waitFor(() => assert.equal(heard.errors.length, 1), {
          signal: t.signal,
        });
        errors.push(heard.errors[0]);
      }

      // Assert
      const [onMain, onThread] = errors;
      assert.equal(sqliteResultCode(onThread)?.code, 1, 'SQLITE_ERROR');
      assert.deepEqual(seen(onThread), seen(onMain));
    });

    it("gives a DOMException of the thread to 'error' as a DOMException with its name", async (t) => {
      // Arrange: a real 'error' message of the thread, captured on its port.
      // No operation makes the thread's notifications give a DOMException, so
      // the captured message carries one in place of its error, encoded as the
      // thread encodes each error, and comes again from the thread's Worker.
      await using folder = await new TemporaryFiles().directory('notify-');
      const path = join(folder.path, 'app.sqlite');
      const clock = createClock();
      using threads = watchThreads();
      await using notifications = await NotificationsThread.create({
        path,
        clock,
      });
      const heard = hear(notifications);
      const [thread] = threads.workers;
      assert.ok(thread);
      const sent: unknown[] = [];
      thread.on('message', (message: unknown) => sent.push(message));
      await notifications.listen('jobs');
      using own = open(path);
      own.exec('DROP TABLE zukhruf_notify_queue');
      await clock.tickAsync(1000);
      await waitFor(() => assert.equal(heard.errors.length, 1), {
        signal: t.signal,
      });
      const isError = (message: unknown) =>
        Reflect.get(Object(message), 'method') === 'error';
      const captured = sent.find((envelope) =>
        Object.values(Object(envelope)).some(isError),
      );
      assert.ok(captured, 'the thread sent its error on the port');
      const forged = structuredClone(captured);
      const message: unknown = Object.values(Object(forged)).find(isError);
      Reflect.set(Object(message), 'params', [
        errors.encode(
          new DOMException('This operation was aborted', 'AbortError'),
        ),
      ]);
      const warnings: unknown[] = [];
      const warned = (warning: Error) => {
        if (warning instanceof ServerWarning) warnings.push(warning);
      };
      process.on('warning', warned);
      try {
        // Act
        thread.emit('message', forged);
        await waitFor(
          () => assert.equal(heard.errors.length + warnings.length, 2),
          { signal: t.signal },
        );

        // Assert
        assert.deepEqual(warnings, []);
        const [, error] = heard.errors;
        assert.ok(error instanceof DOMException, String(error));
        assert.equal(error.name, 'AbortError');
        assert.equal(error.message, 'This operation was aborted');
      } finally {
        process.off('warning', warned);
      }
    });
  });

  describe('takes the calls of one turn in their order', () => {
    void it.each(forms, (form) =>
      it(`${form.name}: a listen and an unlisten of one turn leave no listener`, async (t) => {
        // Arrange
        await using folder = await new TemporaryFiles().directory('notify-');
        const path = join(folder.path, 'app.sqlite');
        await using notifications = await form.make({
          path,
          clock: createClock(),
        });

        // Act
        await untilAborted(
          Promise.all([
            notifications.listen('jobs'),
            notifications.unlisten('jobs'),
          ]),
          t.signal,
        );

        // Assert
        assert.deepEqual(addressesOf(path, process.pid), []);
      }),
    );

    void it.each(forms, (form) =>
      it(`${form.name}: a notify before a listen of the same turn does not come to it`, async (t) => {
        // Arrange
        await using folder = await new TemporaryFiles().directory('notify-');
        await using notifications = await form.make({
          path: join(folder.path, 'app.sqlite'),
          clock: createClock(),
        });
        const heard = hear(notifications);

        // Act
        const sent = Promise.try(() => notifications.notify('jobs', 'before'));
        await untilAborted(notifications.listen('jobs'), t.signal);
        await sent;
        await notifications.notify('jobs', 'after');

        // Assert
        assert.deepEqual(
          (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
          ['after'],
        );
      }),
    );
  });

  it('stops a channel at unlisten, also for a notification that the thread sent before it heard the unlisten', async (t) => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    await using notifications = await NotificationsThread.create({
      path,
      clock: globalThis,
    });
    const heard = hear(notifications);
    await notifications.listen('jobs');
    await notifications.listen('marker');
    await using sender = await startProgram(path, { signal: t.signal });

    using reader = open(path, { readOnly: true });
    // The listener writes its position at its backstop, after the read that
    // sent the row's notification to the host.
    const read = reader.prepare(
      'SELECT count(*) AS read FROM zukhruf_notify_queue q JOIN zukhruf_notify_listener l ON l.position >= q.id WHERE q.payload = ? AND l.process_id = ?',
    );
    const pause = new Int32Array(new SharedArrayBuffer(4));

    // Act: the host's loop is held while the sender notifies and the thread
    // reads, so the notification waits in the host's port.
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['left'] });
    const until = performance.now() + 10_000;
    while (read.get('left', process.pid)?.['read'] === 0) {
      assert.ok(performance.now() < until, 'The thread never read the row');
      Atomics.wait(pause, 0, 0, 50);
    }
    const unlistened = notifications.unlisten('jobs');
    await untilAborted(unlistened, t.signal);
    sender.do({ do: 'notify', channel: 'marker', payloads: ['marker'] });

    // Assert: a notification of "jobs" would come before the marker.
    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
      ['marker'],
    );
  });

  describe('on a clock', () => {
    it('of globalThis, leaves the timers in its thread', async () => {
      // Arrange
      await using folder = await new TemporaryFiles().directory('notify-');
      const timeouts = () =>
        process
          .getActiveResourcesInfo()
          .filter((resource) => resource === 'Timeout').length;
      const before = timeouts();
      await using notifications = await NotificationsThread.create({
        path: join(folder.path, 'app.sqlite'),
        clock: globalThis,
      });

      // Act: the listener's backstop waits on the clock.
      await notifications.listen('jobs');

      // Assert
      assert.equal(timeouts(), before);
    });

    it('that is not globalThis, arms every timer on it and leaves none armed after the dispose', async () => {
      // Arrange: a clock over the system's timers that counts what is armed.
      await using folder = await new TemporaryFiles().directory('notify-');
      const armed = new Set<NodeJS.Timeout>();
      const clock: Clock = {
        performance,
        setTimeout: (callback, ms) => {
          const timer = setTimeout(() => {
            armed.delete(timer);
            callback();
          }, ms);
          armed.add(timer);
          return timer;
        },
        clearTimeout: (timer) => {
          for (const each of armed) {
            if (each !== timer) continue;
            armed.delete(each);
            clearTimeout(each);
          }
        },
      };
      const notifications = await NotificationsThread.create({
        path: join(folder.path, 'app.sqlite'),
        clock,
      });

      // Act
      await notifications.listen('jobs');
      const whileListening = armed.size;
      await notifications[Symbol.asyncDispose]();

      // Assert
      assert.ok(whileListening > 0, "The listener's backstop waits on it");
      assert.equal(armed.size, 0);
    });
  });

  describe('in a host process', () => {
    it('exits by itself once it is disposed', async (t) => {
      // Arrange
      await using folder = await new TemporaryFiles().directory('notify-');

      // Act
      await using child = await startHost(
        folder.path,
        `
          const notifications = await NotificationsThread.create({ path: join(dir, 'app.sqlite'), clock: globalThis });
          const heard = Promise.withResolvers();
          notifications.on('notification', heard.resolve);
          await notifications.listen('jobs');
          await notifications.notify('jobs', 'email');
          const { payload } = await heard.promise;
          await notifications[Symbol.asyncDispose]();
          process.send({ payload });
        `,
      );
      const report = await child.report(t.signal);
      const ended = await child.ended(t.signal);

      // Assert
      assert.deepEqual(report, { payload: 'email' });
      assert.deepEqual(ended, { code: 0, stderr: '' });
    });

    it('rejects a create that cannot open the file and leaves no thread', async (t) => {
      // Arrange
      await using folder = await new TemporaryFiles().directory('notify-');

      // Act
      await using child = await startHost(
        folder.path,
        `
          const created = await outcome(NotificationsThread.create({ path: join(dir, 'missing', 'app.sqlite'), clock: globalThis }));
          process.send({ created: created.name });
        `,
      );
      const report = await child.report(t.signal);
      const ended = await child.ended(t.signal);

      // Assert
      assert.deepEqual(report, { created: 'MissingError' });
      assert.deepEqual(ended, { code: 0, stderr: '' });
    });

    it("rejects a create with the thread's own error when the thread cannot start, and exits by itself", async (t) => {
      // Arrange: a host that --eval started gives its thread --input-type,
      // which Node refuses for a thread of a file.
      await using folder = await new TemporaryFiles().directory('notify-');
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import { NotificationsThread } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
            const created = await NotificationsThread.create({ path: ${JSON.stringify(join(folder.path, 'app.sqlite'))}, clock: globalThis }).then(
              () => 'created',
              (error) => error.code,
            );
            process.stdout.write(created);
          `,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      try {
        // Act
        const [code] = await untilAborted(once(child, 'exit'), t.signal);

        // Assert
        assert.deepEqual(
          { code, stdout },
          { code: 0, stdout: 'ERR_INPUT_TYPE_NOT_ALLOWED' },
        );
      } finally {
        child.kill('SIGKILL');
      }
    });

    void it.each(
      [
        { form: 'Notifications', make: 'new Notifications(options)' },
        {
          form: 'NotificationsThread',
          make: 'await NotificationsThread.create(options)',
        },
      ],
      ({ form, make }) =>
        it(`${form}: an 'error' that nobody hears ends the host process`, async (t) => {
          // Arrange
          await using folder = await new TemporaryFiles().directory('notify-');

          // Act: a listener of 'notification' throws, and nobody listens for 'error'.
          await using child = await startHost(
            folder.path,
            `
              const options = { path: join(dir, 'app.sqlite'), clock: globalThis };
              const notifications = ${make};
              notifications.on('notification', () => { throw new Error('the listener threw'); });
              await notifications.listen('jobs');
              await notifications.notify('jobs', 'email');
            `,
          );
          const { code, stderr } = await child.ended(t.signal);

          // Assert
          assert.equal(code, 1);
          assert.match(stderr, /Error: the listener threw/);
        }),
    );
  });
});
