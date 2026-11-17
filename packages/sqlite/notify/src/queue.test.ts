import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { TemporaryFiles } from '@zukhruf/fs';
import { PipeAddress } from '@zukhruf/pipes';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

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
    return String(Reflect.get(Object(error), 'code'));
  }
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
