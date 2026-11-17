import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { TemporaryFiles } from '@zukhruf/fs';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import { Notifications } from './index.ts';
import { addressesOf, hear, startProgram } from './testing/program.ts';

describe('the contract with other programs', () => {
  test('C1, C5: each listening program gets the channel, the payload and the sender pid; a program on another channel gets nothing', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using first = await startProgram(path, { signal: t.signal });
    await using second = await startProgram(path, { signal: t.signal });
    await using other = await startProgram(path, { signal: t.signal });
    await using sender = await startProgram(path, { signal: t.signal });
    first.do({ do: 'listen', channel: 'jobs' });
    second.do({ do: 'listen', channel: 'jobs' });
    other.do({ do: 'listen', channel: 'mail' });
    for (const program of [first, second, other])
      await program.printedOne((p) => p.event === 'listened');

    sender.do({ do: 'notify', channel: 'jobs', payloads: ['email'] });

    const expected = {
      event: 'notification',
      processId: sender.pid,
      channel: 'jobs',
      payload: 'email',
    };
    assert.deepEqual(await first.heard(1), [expected]);
    assert.deepEqual(await second.heard(1), [expected]);
    // Markers committed after "email": a leaked or doubled row would come
    // before them.
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['jobs marker'] });
    other.do({ do: 'notify', channel: 'mail', payloads: ['mail marker'] });
    for (const program of [first, second])
      assert.deepEqual(
        (await program.heard(2)).map((n) => n.payload),
        ['email', 'jobs marker'],
      );
    assert.deepEqual(
      (await other.heard(1)).map((n) => n.payload),
      ['mail marker'],
    );
  });

  test('C2: a notification of a transaction that rolled back never comes; the next committed one is the only one', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path, { signal: t.signal });
    await using sender = await startProgram(path, { signal: t.signal });
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne((p) => p.event === 'listened');

    sender.do({ do: 'roll back', channel: 'jobs', payload: 'rolled back' });
    await sender.printedOne((p) => p.event === 'rolled back');
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['committed'] });

    await listener.heard(1);
    // The committed one came after the rollback's wake, so the rollback's
    // read is over: had it delivered, it would come first.
    assert.deepEqual(
      listener.notifications.map((n) => n.payload),
      ['committed'],
    );
  });

  test('C3, C13: a notification committed before listen resolved does not come; one committed after does, by a wake from a sender program that sent before the listener came', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    // A listener on another channel keeps "before" from the trim; its clock
    // never moves, so it never writes its position.
    await using keeper = new Notifications({ path, clock: createClock() });
    await keeper.listen('other');
    await using sender = await startProgram(path, { signal: t.signal });
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['before'] });
    await sender.printedOne((p) => p.event === 'sent');
    await using listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');

    sender.do({ do: 'notify', channel: 'jobs', payloads: ['after'] });

    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
      ['after'],
    );
  });

  test('C3: a later listen on a second channel gets only the rows above the commit of that listen', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    // The clock never moves: the listener reads only on a wake.
    await using listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path, { signal: t.signal });
    // Nobody listens on "mail" yet, so nothing reads this row now.
    sender.do({ do: 'notify', channel: 'mail', payloads: ['mail before'] });
    await sender.printedOne((p) => p.event === 'sent');

    await listener.listen('mail');
    sender.do({ do: 'notify', channel: 'mail', payloads: ['mail after'] });

    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
      ['mail after'],
    );
  });

  test('C4: the notification of a transaction comes after its commit, by the wake on the next microtask', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    using database = open(`${folder.path}/app.sqlite`, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    await using notifications = new Notifications({
      database,
      clock: createClock(),
    });
    const heard = hear(notifications);
    await notifications.listen('jobs');

    // The listener of the same instance reads with no socket, and its clock
    // never moves: a wake inside the transaction would find no row, and
    // nothing would read again.
    transaction(database, () => notifications.notify('jobs', 'email'), {
      mode: 'immediate',
    });

    assert.deepEqual(await heard.count(1, { signal: t.signal }), [
      { processId: process.pid, channel: 'jobs', payload: 'email' },
    ]);
  });

  test('C6: the limits of a channel and a payload are Postgres limits in UTF-8 bytes, with its messages', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    await using notifications = new Notifications({
      path: `${folder.path}/app.sqlite`,
      clock: createClock(),
    });

    assert.throws(() => notifications.notify(''), {
      name: 'RangeError',
      message: 'channel name cannot be empty',
    });
    // 'é' is two bytes: 32 of them are 64 bytes, 63 bytes pass.
    assert.throws(() => notifications.notify('é'.repeat(32)), {
      name: 'RangeError',
      message: 'channel name too long',
    });
    notifications.notify(`${'é'.repeat(31)}a`);
    assert.throws(() => notifications.notify('jobs', 'é'.repeat(4000)), {
      name: 'RangeError',
      message: 'payload string too long',
    });
    notifications.notify('jobs', `${'é'.repeat(3999)}a`);
    await assert.rejects(notifications.listen(''), {
      name: 'RangeError',
      message: 'channel name cannot be empty',
    });
    await assert.rejects(notifications.listen('é'.repeat(32)), {
      name: 'RangeError',
      message: 'channel name too long',
    });
  });

  test('C7, C8: the notifications of one transaction come in the order of the calls, identical ones twice, and the payload is "" when none is given', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path, { signal: t.signal });
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne((p) => p.event === 'listened');
    using database = open(path, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    await using sender = new Notifications({
      database,
      clock: createClock(),
    });

    transaction(
      database,
      () => {
        sender.notify('jobs', 'b');
        sender.notify('jobs', 'a');
        sender.notify('jobs', 'a');
        sender.notify('jobs');
      },
      { mode: 'immediate' },
    );

    assert.deepEqual(
      (await listener.heard(4)).map((n) => n.payload),
      ['b', 'a', 'a', ''],
    );
  });

  test('C8: the notifications of two sender programs come in the order of their commits', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path, { signal: t.signal });
    await using a = await startProgram(path, { signal: t.signal });
    await using b = await startProgram(path, { signal: t.signal });
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne((p) => p.event === 'listened');
    // Stopped, the listener reads the rows of both senders in one read.
    listener.child.kill('SIGSTOP');

    for (const [program, payload] of [
      [a, 'a1'],
      [b, 'b1'],
      [a, 'a2'],
      [b, 'b2'],
    ] as const) {
      const sent = program.printed.length;
      program.do({ do: 'notify', channel: 'jobs', payloads: [payload] });
      await program.printedOne(
        (p) => p.event === 'sent' && program.printed.indexOf(p) >= sent,
      );
    }
    listener.child.kill('SIGCONT');

    assert.deepEqual(
      (await listener.heard(4)).map((n) => n.payload),
      ['a1', 'b1', 'a2', 'b2'],
    );
  });

  test('C9: an instance that listens hears its own notification, with the pid of this program', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    await using notifications = new Notifications({
      path: `${folder.path}/app.sqlite`,
      clock: createClock(),
    });
    const heard = hear(notifications);
    await notifications.listen('jobs');

    notifications.notify('jobs', 'email');

    assert.deepEqual(await heard.count(1, { signal: t.signal }), [
      { processId: process.pid, channel: 'jobs', payload: 'email' },
    ]);
  });

  test('C11: dispose removes the listener row and its socket file, and a sender program then sends with no error', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using sender = await startProgram(path, { signal: t.signal });
    const listener = new Notifications({ path, clock: createClock() });
    const heard = hear(listener);
    await listener.listen('jobs');
    const [address] = addressesOf(path, process.pid);
    assert.ok(address);
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['first'] });
    await heard.count(1, { signal: t.signal });

    await listener[Symbol.asyncDispose]();

    assert.deepEqual(addressesOf(path, process.pid), []);
    await assert.rejects(stat(address), { code: 'ENOENT' });
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['second'] });
    await sender.printedOne((p) => p.event === 'sent');
    sender.do({ do: 'notify', channel: 'jobs', payloads: ['third'] });
    await sender.printedOne(
      () => sender.printed.filter((p) => p.event === 'sent').length === 3,
    );
    assert.deepEqual(
      sender.printed.filter((p) => p.event === 'error'),
      [],
    );
  });

  test('C12: a notification of a sender program killed before its wake comes by the backstop of a listener program', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = await startProgram(path, { signal: t.signal });
    await using sender = await startProgram(path, { signal: t.signal });
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne((p) => p.event === 'listened');

    sender.do({ do: 'notify and die', channel: 'jobs', payload: 'durable' });
    assert.equal(await sender.exited, null);

    assert.deepEqual(
      (await listener.heard(1)).map((n) => n.payload),
      ['durable'],
    );
  });
});

describe('the backstop on the clock', () => {
  test('a sender program killed before its wake: the row comes at the next backstop of the listener', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    const clock = createClock();
    await using listener = new Notifications({ path, clock });
    const heard = hear(listener);
    await listener.listen('jobs');
    await using sender = await startProgram(path, { signal: t.signal });

    sender.do({ do: 'notify and die', channel: 'jobs', payload: 'durable' });
    assert.equal(await sender.exited, null);
    await clock.tickAsync(1000);

    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
      ['durable'],
    );
  });

  test('a transaction held open across an await gets its wake before the commit; the backstop finds the row', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const clock = createClock();
    using database = open(`${folder.path}/app.sqlite`, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    // One instance: its own listener reads on the microtask of the wake,
    // with no socket.
    await using notifications = new Notifications({ database, clock });
    const heard = hear(notifications);
    await notifications.listen('jobs');

    database.exec('BEGIN IMMEDIATE');
    notifications.notify('jobs', 'late');
    await new Promise(setImmediate);
    database.exec('COMMIT');
    await new Promise(setImmediate);
    assert.deepEqual(heard.notifications, []);
    await clock.tickAsync(1000);

    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map((n) => n.payload),
      ['late'],
    );
  });
});

describe('the socket folder', () => {
  test('a listener serves its socket in /tmp/zukhruf-sqlite-notify-<uid>, a folder of mode 0700, at a path of at most 70 bytes', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = `${folder.path}/app.sqlite`;
    await using listener = new Notifications({ path, clock: createClock() });
    await listener.listen('jobs');

    const [address] = addressesOf(path, process.pid);
    const socketFolder = `/tmp/zukhruf-sqlite-notify-${process.getuid!()}`;
    assert.match(address!, new RegExp(`^${socketFolder}/[0-9a-f]{32}$`));
    assert.ok(Buffer.byteLength(address!) <= 70);
    assert.ok((await stat(address!)).isSocket());
    assert.equal((await stat(socketFolder)).mode & 0o777, 0o700);
  });
});
