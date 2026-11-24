import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import { createClock } from '@sinonjs/fake-timers';

import { FileLock, TemporaryFiles } from '@zukhruf/fs';
import { NoServerError, PipeAddress } from '@zukhruf/pipes';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';
import { waitFor } from '@zukhruf/testing/async';

import { Notifications } from './index.ts';
import { addressesOf, hear, startProgram } from './testing/program.ts';

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

function rowsIn(path: string): number {
  using reader = open(path, { readOnly: true });
  return Number(
    reader.prepare('SELECT count(*) AS rows FROM zukhruf_notify_queue').get()?.[
      'rows'
    ],
  );
}

function positionsIn(path: string): number[] {
  using reader = open(path, { readOnly: true });
  return reader
    .prepare('SELECT position FROM zukhruf_notify_listener')
    .all()
    .map((row) => Number(row['position']));
}

// The sender connects on the microtask after its notify. A connect that the
// test starts after that one ends after it too, so by then the sender knows
// whether the listener is dead.
async function connectAfterTheSender(address: string): Promise<string> {
  await null;
  try {
    (await new PipeAddress(address).connect()).destroy();
    return 'connected';
  } catch (error) {
    // A connect that no server accepts rejects with NoServerError over the error of Node.js.
    const failure = error instanceof NoServerError ? error.cause : error;
    return String(Reflect.get(Object(failure), 'code'));
  }
}

// The presence files of the listeners of the file at `path`: the folder
// beside the database that a release with presences makes (ADR 0011).
async function presencesOf(path: string): Promise<string[]> {
  try {
    return await readdir(`${path}.listeners`);
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') return [];
    throw error;
  }
}

// What a sender in another program reads of a presence file.
async function presenceInAnotherProgram(file: string): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { FileLock } from '@zukhruf/fs'; process.stdout.write(FileLock.check(${JSON.stringify(file)}));`,
  ]);
  return stdout;
}

function jobsIn(path: string): string[] {
  using reader = open(path, { readOnly: true });
  return reader
    .prepare('SELECT name FROM jobs')
    .all()
    .map((row) => String(row['name']));
}

describe('the queue holds a row until each listener read it', () => {
  test('C10: a full queue fails the sender program with QueueFullError, and its transaction does not commit; the listener position frees it', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using listener = new Notifications({ path, clock });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path, {
      signal: t.signal,
      maxQueuedNotifications: 3,
    });
    const outcomes = () =>
      sender.printed.filter(
        (p) => p.event === 'committed' || p.event === 'failed',
      );
    const send = async (payload: string) => {
      const before = outcomes().length;
      sender.do({ do: 'notify with a job', channel: 'jobs', payload });
      await sender.printedOne(() => outcomes().length > before);
      return outcomes().at(-1);
    };

    for (const payload of ['j0', 'j1', 'j2'])
      assert.equal((await send(payload))?.event, 'committed');
    await heard.count(3, { signal: t.signal });
    assert.deepEqual(await send('j3'), {
      event: 'failed',
      name: 'QueueFullError',
      code: '54000',
      message: 'too many notifications in the NOTIFY queue',
    });
    assert.deepEqual(jobsIn(path), ['j0', 'j1', 'j2']);

    await clock.tickAsync(1000);

    assert.equal((await send('j4'))?.event, 'committed');
    assert.deepEqual(
      (await heard.count(4, { signal: t.signal })).map((n) => n.payload),
      ['j0', 'j1', 'j2', 'j4'],
    );
  });

  test('the trim keeps every row that a stopped listener program has not read', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path, { signal: t.signal });
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne((p) => p.event === 'listened');
    listener.child.kill('SIGSTOP');
    const clock = createClock();
    await using sender = new Notifications({ path, clock });

    const payloads = numbered('n', 5);
    for (const payload of payloads) {
      sender.notify('jobs', payload);
      // Past the trim interval, so each notify trims.
      clock.tick(1000);
    }
    assert.equal(rowsIn(path), 5);
    listener.child.kill('SIGCONT');

    assert.deepEqual(
      (await listener.heard(5)).map((n) => n.payload),
      payloads,
    );
  });

  test('with no listener, a trim deletes at most 10,000 rows, at most once a second; a later listener still gets the new rows', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    const clock = createClock();
    await using sender = new Notifications({ database, clock });

    // The first notify trims, and the rest of the second do not.
    transaction(
      database,
      () => {
        for (let i = 0; i < 10_005; i++) sender.notify('jobs');
      },
      { mode: 'immediate' },
    );
    assert.equal(rowsIn(path), 10_004);
    clock.tick(999);
    sender.notify('jobs');
    assert.equal(rowsIn(path), 10_005);
    clock.tick(1);
    sender.notify('jobs');
    assert.equal(rowsIn(path), 6);
    clock.tick(1000);
    sender.notify('jobs');
    assert.equal(rowsIn(path), 0);

    await using listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');
    sender.notify('jobs', 'after the trim');
    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
      ['after the trim'],
    );
  });

  test('a position write that finds the file busy is skipped, and a later backstop writes it', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using listener = new Notifications({ path, clock });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using other = await startProgram(path, { signal: t.signal });
    other.do({ do: 'notify', channel: 'jobs', payloads: ['read'] });
    await heard.count(1, { signal: t.signal });
    other.do({ do: 'hold the write lock' });
    await other.printedOne((p) => p.event === 'locked');

    await clock.tickAsync(1000);
    assert.deepEqual(positionsIn(path), [0]);
    other.do({ do: 'release the write lock' });
    await other.printedOne((p) => p.event === 'released');
    await clock.tickAsync(1000);

    assert.deepEqual(positionsIn(path), [1]);
    assert.deepEqual(heard.errors, []);
  });
});

describe('the trim wakes the listener at the lowest position, whatever its channel', () => {
  test('a listener program killed on a channel that nobody sends on: the sends on another channel never fill the queue, and its rows and its socket file go', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'quiet' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    await using busy = new Notifications({ path, clock });
    const heard = hear(busy);
    await busy.listen('busy');
    await using sender = new Notifications({
      path,
      clock,
      maxQueuedNotifications: 3,
    });
    const errors = hear(sender).errors;
    killed.child.kill('SIGKILL');
    await killed.exited;

    sender.notify('busy', 'n0');
    assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');
    for (const payload of numbered('n', 6).slice(1)) {
      await clock.tickAsync(1000);
      sender.notify('busy', payload);
    }

    assert.deepEqual(addressesOf(path, killed.pid), []);
    assert.deepEqual(
      (await heard.count(6, { signal: t.signal })).map((n) => n.payload),
      numbered('n', 6),
    );
    await sender[Symbol.asyncDispose]();
    await assert.rejects(stat(address), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
  });

  test("a dead listener's removal in a caller's transaction that rolls back: the sender still knows it dead, and its next send removes its rows and its socket file", async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    // The clock never moves, so no trim after the first wakes the dead one.
    await using sender = new Notifications({ database, clock: createClock() });
    const errors = hear(sender).errors;
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'quiet' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    killed.child.kill('SIGKILL');
    await killed.exited;
    sender.notify('quiet', 'a');
    assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');

    assert.throws(
      () =>
        transaction(
          database,
          () => {
            sender.notify('quiet', 'b');
            throw new Error('roll back');
          },
          { mode: 'immediate' },
        ),
      /roll back/,
    );
    assert.equal(addressesOf(path, killed.pid).length, 1);
    sender.notify('busy', 'c');

    assert.deepEqual(addressesOf(path, killed.pid), []);
    await sender[Symbol.asyncDispose]();
    await assert.rejects(stat(address), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
  });

  test("a sender that notifies only in a caller's transactions that commit removes a killed listener's row, and its socket file before its dispose ends", async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    await using sender = new Notifications({ database, clock: createClock() });
    const errors = hear(sender).errors;
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'jobs' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    killed.child.kill('SIGKILL');
    await killed.exited;
    const insertJob = (payload: string) =>
      transaction(database, () => sender.notify('jobs', payload), {
        mode: 'immediate',
      });

    insertJob('a');
    assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');
    insertJob('b');

    assert.deepEqual(addressesOf(path, killed.pid), []);
    await sender[Symbol.asyncDispose]();
    await assert.rejects(stat(address), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
  });

  test("a dead listener's removal in a caller's transaction that rolls back: past the microtask the sender still knows it dead, and its next send removes its rows and its socket file", async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    await using sender = new Notifications({ database, clock: createClock() });
    const errors = hear(sender).errors;
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'jobs' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    killed.child.kill('SIGKILL');
    await killed.exited;
    sender.notify('jobs', 'a');
    assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');

    assert.throws(
      () =>
        transaction(
          database,
          () => {
            sender.notify('jobs', 'b');
            throw new Error('roll back');
          },
          { mode: 'immediate' },
        ),
      /roll back/,
    );
    // The check of the removal runs on the microtask after the notify.
    await null;
    await null;
    assert.equal(addressesOf(path, killed.pid).length, 1);
    sender.notify('jobs', 'c');

    assert.deepEqual(addressesOf(path, killed.pid), []);
    await sender[Symbol.asyncDispose]();
    await assert.rejects(stat(address), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
  });

  test("a dead listener's removal in a caller's transaction that stays open past the microtask and then rolls back: the sender still knows it dead, and its next send removes its rows and its socket file", async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    await using sender = new Notifications({ database, clock: createClock() });
    const errors = hear(sender).errors;
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'jobs' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    killed.child.kill('SIGKILL');
    await killed.exited;
    sender.notify('jobs', 'a');
    assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');

    database.exec('BEGIN IMMEDIATE');
    try {
      sender.notify('jobs', 'b');
      // The check of the removal runs on the microtask after the notify.
      await null;
      await null;
    } finally {
      database.exec('ROLLBACK');
    }
    assert.equal(addressesOf(path, killed.pid).length, 1);
    sender.notify('jobs', 'c');

    assert.deepEqual(addressesOf(path, killed.pid), []);
    await sender[Symbol.asyncDispose]();
    await assert.rejects(stat(address), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
  });

  test('a stopped listener program on a channel that nobody else sends on keeps its row when the trim wakes it, and after SIGCONT gets every row of its channel once, in order', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using hung = await startProgram(path, { signal: t.signal });
    hung.do({ do: 'listen', channel: 'quiet' });
    await hung.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, hung.pid);
    assert.ok(address);
    hung.child.kill('SIGSTOP');
    await using sender = new Notifications({ path, clock });
    const errors = hear(sender).errors;

    const payloads = numbered('q', 3);
    for (const payload of payloads) sender.notify('quiet', payload);
    // Its unread rows of 'quiet' stay through each trim that wakes it.
    for (const payload of numbered('b', 3)) {
      sender.notify('busy', payload);
      assert.equal(await connectAfterTheSender(address), 'connected');
      clock.tick(1000);
    }
    sender.notify('busy', 'b3');
    assert.equal(addressesOf(path, hung.pid).length, 1);
    hung.child.kill('SIGCONT');

    assert.deepEqual(
      (await hung.heard(3)).map((n) => n.payload),
      payloads,
    );
    assert.deepEqual(errors, []);
  });
});

describe('a full listen queue', () => {
  test(
    'a stopped listener program whose listen queue is full refuses the wake, and still keeps its rows and its socket file; after SIGCONT it gets every notification',
    {
      skip:
        process.platform !== 'darwin' &&
        'only macOS refuses a connect to a live server whose listen queue is full, with the ECONNREFUSED of a dead server; Linux gives EAGAIN',
    },
    async (t) => {
      await using folder = await new TemporaryFiles().directory('notify-');
      const path = `${folder.path}/app.sqlite`;
      await using hung = await startProgram(path, { signal: t.signal });
      hung.do({ do: 'listen', channel: 'jobs' });
      await hung.printedOne((p) => p.event === 'listened');
      const [address] = addressesOf(path, hung.pid);
      assert.ok(address);
      hung.child.kill('SIGSTOP');
      // The connects that fill the queue of the stopped program, as a flood of
      // new senders does: platform setup that no operation exposes.
      const queued: Socket[] = [];
      try {
        for (;;) {
          try {
            queued.push(await new PipeAddress(address).connect());
          } catch (error) {
            if (error instanceof NoServerError) break;
            throw error;
          }
        }
        await using sender = new Notifications({ path, clock: createClock() });
        hear(sender);

        sender.notify('jobs', 'n0');
        assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');
        sender.notify('jobs', 'n1');
        await sender[Symbol.asyncDispose]();

        assert.equal(addressesOf(path, hung.pid).length, 1);
        assert.ok((await stat(address)).isSocket());
      } finally {
        for (const socket of queued) socket.destroy();
      }
      hung.child.kill('SIGCONT');
      assert.deepEqual(
        (await hung.heard(2)).map((n) => n.payload),
        ['n0', 'n1'],
      );
    },
  );
});

describe("a listener's presence beside the database", () => {
  test('a listener holds a presence file while it listens; its last unlisten removes it, and so does its dispose', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    {
      await using listener = new Notifications({ path, clock: createClock() });
      await listener.listen('jobs');
      assert.equal((await presencesOf(path)).length, 1);
      await listener.unlisten('jobs');
      assert.deepEqual(await presencesOf(path), []);

      await listener.listen('mail');
      assert.equal((await presencesOf(path)).length, 1);
    }

    assert.deepEqual(await presencesOf(path), []);
  });

  test('a listener program takes its presence before its row: while another program holds the write lock, its presence is locked and it has no row yet', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path, { signal: t.signal });
    await using holder = await startProgram(path, { signal: t.signal });
    holder.do({ do: 'hold the write lock' });
    await holder.printedOne((p) => p.event === 'locked');

    listener.do({ do: 'listen', channel: 'jobs' });
    // Its row waits for the write lock; the listen fails after the busy
    // timeout of 5 s, and prints its error.
    const presences = await waitFor(
      async () => {
        const found = await presencesOf(path);
        assert.ok(
          found.length > 0 || listener.printed.some((p) => p.event !== 'ready'),
        );
        return found;
      },
      { signal: t.signal },
    );

    assert.equal(presences.length, 1);
    assert.equal(FileLock.check(`${path}.listeners/${presences[0]}`), 'locked');
    assert.deepEqual(addressesOf(path, listener.pid), []);
    holder.do({ do: 'release the write lock' });
    await listener.printedOne((p) => p.event === 'listened');
    assert.equal(addressesOf(path, listener.pid).length, 1);
  });

  test("a killed listener program's presence file goes with its rows", async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'jobs' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    assert.equal((await presencesOf(path)).length, 1);
    killed.child.kill('SIGKILL');
    await killed.exited;
    await using sender = new Notifications({ path, clock: createClock() });
    const errors = hear(sender).errors;

    sender.notify('jobs', 'n0');
    await connectAfterTheSender(address);
    sender.notify('jobs', 'n1');
    await sender[Symbol.asyncDispose]();

    assert.deepEqual(addressesOf(path, killed.pid), []);
    assert.deepEqual(await presencesOf(path), []);
    assert.deepEqual(errors, []);
  });

  test('a killed listener program with no presence file, as a release before presences leaves it, counts as dead on a refused connect: its rows and its socket file go', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using killed = await startProgram(path, { signal: t.signal });
    killed.do({ do: 'listen', channel: 'jobs' });
    await killed.printedOne((p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    killed.child.kill('SIGKILL');
    await killed.exited;
    // An older release makes no presence folder: platform setup that no
    // operation of this release exposes.
    await rm(`${path}.listeners`, { recursive: true });
    await using sender = new Notifications({ path, clock: createClock() });
    const errors = hear(sender).errors;

    sender.notify('jobs', 'n0');
    assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');
    sender.notify('jobs', 'n1');
    await sender[Symbol.asyncDispose]();

    assert.deepEqual(addressesOf(path, killed.pid), []);
    await assert.rejects(stat(address), { code: 'ENOENT' });
    assert.deepEqual(errors, []);
  });

  test('a live listener program whose socket file is gone, or is not a socket, is removed by a send, though its presence is locked', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using gone = await startProgram(path, { signal: t.signal });
    await using replaced = await startProgram(path, { signal: t.signal });
    gone.do({ do: 'listen', channel: 'jobs' });
    replaced.do({ do: 'listen', channel: 'jobs' });
    await gone.printedOne((p) => p.event === 'listened');
    await replaced.printedOne((p) => p.event === 'listened');
    const [goneAddress] = addressesOf(path, gone.pid);
    const [replacedAddress] = addressesOf(path, replaced.pid);
    assert.ok(goneAddress && replacedAddress);
    // What a cleaner of the temporary folder does: platform setup that no
    // operation exposes.
    await rm(goneAddress);
    await rm(replacedAddress);
    await writeFile(replacedAddress, '');
    await using sender = new Notifications({ path, clock: createClock() });
    const errors = hear(sender).errors;

    sender.notify('jobs', 'n0');
    assert.equal(await connectAfterTheSender(goneAddress), 'ENOENT');
    assert.equal(
      await connectAfterTheSender(replacedAddress),
      process.platform === 'darwin' ? 'ENOTSOCK' : 'ECONNREFUSED',
    );
    sender.notify('jobs', 'n1');
    await sender[Symbol.asyncDispose]();

    assert.deepEqual(addressesOf(path, gone.pid), []);
    assert.deepEqual(addressesOf(path, replaced.pid), []);
    assert.deepEqual(errors, []);
  });

  test(
    'a sender in the process of a live listener whose listen queue is full asks its presence, which stays locked for every program: the listener keeps its rows, the lost wake goes to error, and it gets every notification',
    {
      skip:
        process.platform !== 'darwin' &&
        'only macOS refuses a connect to a live server whose listen queue is full, with the ECONNREFUSED of a dead server; Linux gives EAGAIN',
    },
    async (t) => {
      await using folder = await new TemporaryFiles().directory('notify-');
      const path = `${folder.path}/app.sqlite`;
      await using listener = new Notifications({ path, clock: createClock() });
      const heard = hear(listener);
      await listener.listen('jobs');
      const [address] = addressesOf(path, process.pid);
      assert.ok(address);
      const [presence] = await presencesOf(path);
      assert.ok(presence);
      await using sender = new Notifications({ path, clock: createClock() });
      const errors = hear(sender).errors;
      // A worker fills the listen queue while this thread waits and so
      // accepts nothing, as a flood of new senders does: platform setup that
      // no operation exposes.
      const filled = new Int32Array(new SharedArrayBuffer(4));
      const flood = new Worker(
        `
        const { workerData } = require('node:worker_threads');
        const { connect } = require('node:net');
        const sockets = [];
        const next = () => {
          const socket = connect({ path: workerData.address });
          socket.once('connect', () => { sockets.push(socket); next(); });
          socket.once('error', () => {
            Atomics.store(workerData.filled, 0, 1);
            Atomics.notify(workerData.filled, 0);
          });
        };
        next();
        `,
        { eval: true, workerData: { address, filled } },
      );
      try {
        assert.equal(Atomics.wait(filled, 0, 0, 30_000), 'ok');

        sender.notify('jobs', 'n0');
        assert.equal(await connectAfterTheSender(address), 'ECONNREFUSED');
        await flood.terminate();
        sender.notify('jobs', 'n1');

        assert.equal(addressesOf(path, process.pid).length, 1);
        assert.equal(
          await presenceInAnotherProgram(`${path}.listeners/${presence}`),
          'locked',
        );
        assert.deepEqual(
          (await heard.count(2, { signal: t.signal })).map((n) => n.payload),
          ['n0', 'n1'],
        );
        assert.equal(errors.length, 1);
        assert.ok(errors[0] instanceof NoServerError);
      } finally {
        await flood.terminate();
      }
    },
  );
});
