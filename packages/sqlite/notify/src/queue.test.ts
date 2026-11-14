import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { Notifications } from './index.ts';
import { hear, startProgram } from './testing/program.ts';

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

function jobsIn(path: string): string[] {
  using reader = open(path, { readOnly: true });
  return reader
    .prepare('SELECT name FROM jobs')
    .all()
    .map((row) => String(row['name']));
}

describe('the queue holds a row until each listener read it', () => {
  test('C10: a full queue fails the sender program with QueueFullError, and its transaction does not commit; the listener position frees it', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using listener = new Notifications({ path, clock });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path, {
      maxQueuedNotifications: 3,
    });
    const outcomes = () =>
      sender.printed.filter(
        (p) => p.event === 'committed' || p.event === 'failed',
      );
    const send = async (payload: string) => {
      const before = outcomes().length;
      sender.do({ do: 'notify with a job', channel: 'jobs', payload });
      await sender.printedOne(
        `the outcome of ${payload}`,
        () => outcomes().length > before,
      );
      return outcomes().at(-1);
    };

    for (const payload of ['j0', 'j1', 'j2'])
      assert.equal((await send(payload))?.event, 'committed');
    await heard.count(3);
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
      (await heard.count(4)).map((n) => n.payload),
      ['j0', 'j1', 'j2', 'j4'],
    );
  });

  test('the trim keeps every row that a stopped listener program has not read', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path);
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne('listened', (p) => p.event === 'listened');
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

  test('with no listener, a trim deletes at most 10,000 rows, at most once a second; a later listener still gets the new rows', async () => {
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
      (await heard.count(1)).map((n) => n.payload),
      ['after the trim'],
    );
  });

  test('a position write that finds the file busy is skipped, and a later backstop writes it', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using listener = new Notifications({ path, clock });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using other = await startProgram(path);
    other.do({ do: 'notify', channel: 'jobs', payloads: ['read'] });
    await heard.count(1);
    other.do({ do: 'hold the write lock' });
    await other.printedOne('locked', (p) => p.event === 'locked');

    await clock.tickAsync(1000);
    assert.deepEqual(positionsIn(path), [0]);
    other.do({ do: 'release the write lock' });
    await other.printedOne('released', (p) => p.event === 'released');
    await clock.tickAsync(1000);

    assert.deepEqual(positionsIn(path), [1]);
    assert.deepEqual(heard.errors, []);
  });
});
