import assert from 'node:assert/strict';
import { chmod, stat, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { TemporaryFiles } from '@zukhruf/fs';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { settleWithin } from '@zukhruf/testing/async';

import {
  DeniedError,
  DisposedError,
  MissingError,
  Notifications,
  UnavailableError,
} from './index.ts';
import {
  addressesOf,
  factTimeout,
  hear,
  startProgram,
} from './testing/program.ts';

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`);

describe('other programs fail', () => {
  test('a killed listener program: a later send removes its rows and its socket file, and the other listener gets every notification', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using alive = await startProgram(path);
    await using killed = await startProgram(path);
    alive.do({ do: 'listen', channel: 'jobs' });
    killed.do({ do: 'listen', channel: 'jobs' });
    await alive.printedOne('listened', (p) => p.event === 'listened');
    await killed.printedOne('listened', (p) => p.event === 'listened');
    const [address] = addressesOf(path, killed.pid);
    assert.ok(address);
    killed.child.kill('SIGKILL');
    await killed.exited;
    assert.ok((await stat(address)).isSocket());
    await using sender = new Notifications({ path, clock: createClock() });
    const errors = hear(sender).errors;

    let sent = 0;
    await t.waitFor(
      () => {
        sender.notify('jobs', `n${sent++}`);
        assert.deepEqual(addressesOf(path, killed.pid), []);
      },
      { timeout: factTimeout },
    );
    await t.waitFor(() => assert.rejects(stat(address), { code: 'ENOENT' }), {
      timeout: factTimeout,
    });

    assert.deepEqual(
      (await alive.heard(sent)).map((n) => n.payload),
      numbered('n', sent),
    );
    assert.deepEqual(errors, []);
  });

  test('a hung listener program (SIGSTOP): the other listener gets each notification meanwhile; after SIGCONT the hung one gets every row once, in order', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using alive = await startProgram(path);
    await using hung = await startProgram(path);
    await using sender = await startProgram(path);
    alive.do({ do: 'listen', channel: 'jobs' });
    hung.do({ do: 'listen', channel: 'jobs' });
    await alive.printedOne('listened', (p) => p.event === 'listened');
    await hung.printedOne('listened', (p) => p.event === 'listened');
    hung.child.kill('SIGSTOP');

    const payloads = numbered('n', 200);
    for (const [i, payload] of payloads.entries()) {
      sender.do({ do: 'notify', channel: 'jobs', payloads: [payload] });
      assert.equal((await alive.heard(i + 1)).at(-1)!.payload, payload);
    }
    hung.child.kill('SIGCONT');
    await hung.heard(200);
    // A marker committed after the last: a doubled row would come before it.
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['marker'] });

    for (const program of [alive, hung])
      assert.deepEqual(
        (await program.heard(201)).map((n) => n.payload),
        [...payloads, 'marker'],
      );
    assert.deepEqual(
      sender.printed.filter((p) => p.event === 'error'),
      [],
    );
  });

  test('two sender programs at once: the listener program gets every row once, each series in its order', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path);
    await using a = await startProgram(path);
    await using b = await startProgram(path);
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne('listened', (p) => p.event === 'listened');

    a.do({ do: 'notify', channel: 'jobs', payloads: numbered('a', 300) });
    b.do({ do: 'notify', channel: 'jobs', payloads: numbered('b', 300) });

    await a.printedOne('a sent', (p) => p.event === 'sent');
    await b.printedOne('b sent', (p) => p.event === 'sent');
    await listener.heard(600);
    // A marker committed after the last: a doubled row would come before it.
    a.do({ do: 'notify', channel: 'jobs', payloads: ['marker'] });
    const payloads = (await listener.heard(601)).map((n) => String(n.payload));
    assert.equal(payloads.at(-1), 'marker');
    assert.equal(payloads.length, 601);
    assert.deepEqual(
      payloads.filter((p) => p.startsWith('a')),
      numbered('a', 300),
    );
    assert.deepEqual(
      payloads.filter((p) => p.startsWith('b')),
      numbered('b', 300),
    );
  });

  test('a sender program that commits one notification each microtask, while a wake is in flight, delivers every row by wakes alone', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    // The clock never moves, so only wakes deliver.
    await using listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path);

    for (const round of [0, 1, 2])
      sender.do({
        do: 'notify',
        channel: 'jobs',
        payloads: numbered(`r${round}-`, 50),
        turns: 'microtask',
      });

    assert.deepEqual(
      (await heard.count(150)).map((n) => n.payload),
      [...numbered('r0-', 50), ...numbered('r1-', 50), ...numbered('r2-', 50)],
    );
  });

  test('a sender program that woke a listener and never disposed exits on its own', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path);

    sender.do({ do: 'notify and leave', channel: 'jobs', payload: 'bye' });

    await heard.count(1);
    assert.equal(
      await settleWithin(sender.exited, 'the sender exits', factTimeout),
      0,
    );
  });
});

describe('dispose and unlisten', () => {
  test('a sender program that disposes right after its notify, before its first connect, still wakes the listener', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    // The clock never moves, so only the wake delivers.
    await using listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path);

    sender.do({ do: 'notify and dispose', channel: 'jobs', payload: 'last' });

    await sender.printedOne('disposed', (p) => p.event === 'disposed');
    assert.deepEqual(
      (await heard.count(1)).map((n) => n.payload),
      ['last'],
    );
  });

  test('unlisten stops the channel at once; the last unlisten removes the rows and the socket file; repeated calls do nothing', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using notifications = new Notifications({
      path,
      clock: createClock(),
    });
    const heard = hear(notifications);
    await notifications.listen('jobs');
    await notifications.listen('jobs');
    await notifications.listen('mail');
    const [address] = addressesOf(path, process.pid);
    assert.ok(address);

    // The unlisten waits behind a listen that is still running, and the wake
    // of "unheard" is read before the unlisten gets its turn.
    const listening = notifications.listen('news');
    notifications.notify('jobs', 'unheard');
    const stopped = notifications.unlisten('jobs');
    notifications.notify('mail', 'heard');
    await listening;
    await stopped;
    await notifications.unlisten('jobs');
    assert.deepEqual(
      (await heard.count(1)).map((n) => n.payload),
      ['heard'],
    );
    assert.equal(addressesOf(path, process.pid).length, 1);

    await notifications.unlisten('news');
    await notifications.unlisten('mail');

    assert.deepEqual(addressesOf(path, process.pid), []);
    await assert.rejects(stat(address), { code: 'ENOENT' });
    notifications.notify('mail', 'after');
    await new Promise(setImmediate);
    assert.deepEqual(
      heard.notifications.map((n) => n.payload),
      ['heard'],
    );
    assert.deepEqual(heard.errors, []);
  });

  test('two listen calls at once register one listener row, and each channel gets its notifications', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using notifications = new Notifications({
      path,
      clock: createClock(),
    });
    const heard = hear(notifications);

    await Promise.all([
      notifications.listen('jobs'),
      notifications.listen('mail'),
    ]);
    notifications.notify('jobs', 'job');
    notifications.notify('mail', 'letter');

    assert.equal(addressesOf(path, process.pid).length, 1);
    assert.deepEqual(
      (await heard.count(2)).map((n) => n.payload),
      ['job', 'letter'],
    );
    assert.deepEqual(heard.errors, []);
  });

  test('{ path } closes its own connection at dispose; { database } leaves the caller connection open', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    const borrowed = new Notifications({ database, clock: createClock() });
    const owned = new Notifications({ path, clock: createClock() });

    await borrowed[Symbol.asyncDispose]();
    await owned[Symbol.asyncDispose]();

    assert.equal(database.prepare('SELECT 1 AS one').get()?.['one'], 1);
    // The owned connection is closed, so its file has no WAL connection left
    // but the caller's: the caller can switch the journal.
    assert.equal(
      database.prepare('PRAGMA journal_mode = DELETE').get()?.['journal_mode'],
      'delete',
    );
  });
});

describe('errors', () => {
  test('a call after dispose throws DisposedError, and a second dispose resolves', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const notifications = new Notifications({
      path: `${folder.path}/app.sqlite`,
      clock: createClock(),
    });
    await notifications.listen('jobs');

    await notifications[Symbol.asyncDispose]();

    assert.throws(() => notifications.notify('jobs'), DisposedError);
    await assert.rejects(notifications.listen('jobs'), DisposedError);
    await assert.rejects(notifications.unlisten('jobs'), DisposedError);
    await notifications[Symbol.asyncDispose]();
  });

  test('a notification listener that throws sends its error to error, and the next notifications of the read still come', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using notifications = new Notifications({
      path,
      clock: createClock(),
    });
    const heard = hear(notifications);
    const thrown = new Error('handler');
    notifications.once('notification', () => {
      throw thrown;
    });
    await notifications.listen('jobs');

    notifications.notify('jobs', 'first');
    notifications.notify('jobs', 'second');

    assert.deepEqual(
      (await heard.count(2)).map((n) => n.payload),
      ['first', 'second'],
    );
    assert.deepEqual(heard.errors, [thrown]);
  });

  test(
    'a database in memory is a TypeError; a missing folder is a MissingError; a denied file is a DeniedError',
    {
      skip: process.getuid?.() === 0 && 'root reads a file of mode 000',
    },
    async () => {
      await using folder = await new TemporaryFiles().directory('notify-');
      using memory = open(':memory:');
      const denied = `${folder.path}/denied.sqlite`;
      await writeFile(denied, '');
      await chmod(denied, 0o000);

      assert.throws(
        () => new Notifications({ database: memory, clock: createClock() }),
        TypeError,
      );
      assert.throws(
        () =>
          new Notifications({
            path: `${folder.path}/missing/app.sqlite`,
            clock: createClock(),
          }),
        (error) =>
          error instanceof MissingError && error instanceof UnavailableError,
      );
      assert.throws(
        () => new Notifications({ path: denied, clock: createClock() }),
        DeniedError,
      );
    },
  );
});
