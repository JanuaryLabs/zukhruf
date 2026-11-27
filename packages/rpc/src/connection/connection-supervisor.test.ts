import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';
import { startWorker } from '@zukhruf/testing/process';

import { isRecord } from '../shared/is-record.ts';
import { scriptedConnector, scriptedPeer } from '../testing/scripted-peer.ts';
import { watch } from '../testing/watch.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';

const supervisorUrl = new URL('./connection-supervisor.ts', import.meta.url);
const processChannelConnectionUrl = new URL(
  '../channel/process-channel-connection.ts',
  import.meta.url,
);

/** How long a test gives a wrong step to happen. */
const settle = 50;

interface Message {
  n: number;
}

/** A supervisor over a scripted connector, and every notification it gave, in order. */
function supervised() {
  const { connector, calls } = scriptedConnector<Message>();
  const supervisor = new ConnectionSupervisor(connector);
  const events: string[] = [];
  supervisor.on('connected', () => events.push('connected'));
  // The supervisor carries messages unchecked; this test only ever delivers a Message.
  supervisor.on('message', (message) =>
    events.push(
      isRecord(message) && typeof message.n === 'number'
        ? `message ${message.n}`
        : `unreadable message ${JSON.stringify(message)}`,
    ),
  );
  supervisor.on('disconnected', () => events.push('disconnected'));
  supervisor.on('unavailable', () => events.push('unavailable'));
  supervisor.on('failed', (error) => events.push(`failed: ${String(error)}`));
  return { supervisor, calls, events };
}

describe('Connection supervisor', () => {
  // Kept as a double: a real campaign cannot be held open to land a close inside it (be7d968).
  test('closing while connecting aborts the connect, and finishes only after it settles', async (t) => {
    // Arrange: a connector that settles only when the test says so.
    const connecting = Promise.withResolvers<undefined>();
    let signal: AbortSignal | undefined;
    const supervisor = new ConnectionSupervisor<Message>({
      connect: (abort) => {
        signal = abort;
        return connecting.promise;
      },
    });
    supervisor.open();

    // Act
    const close = supervisor.close();
    const closing = watch(close);
    await delay(settle);
    const beforeSettled = closing.now.status;
    connecting.reject(signal?.reason);

    // Assert
    assert.equal(signal?.aborted, true, 'Close must abort the connect');
    assert.equal(
      beforeSettled,
      'pending',
      'Close must wait for the connect it aborted',
    );
    // Close must finish once the connect settles.
    await untilAborted(close, t.signal);
  });

  // Kept as a double: every shipped connector is async, so only a stand-in throws before it returns a promise.
  test('a connector that throws before it returns a promise is reported as failed', async (t) => {
    // Arrange
    const events: string[] = [];
    const supervisor = new ConnectionSupervisor<Message>({
      connect: () => {
        throw new Error('EACCES');
      },
    });
    supervisor.on('failed', (error) => events.push(String(error)));

    try {
      // Act
      const failed = once(supervisor, 'failed');
      supervisor.open();

      // Assert
      // The failure must be reported.
      await untilAborted(failed, t.signal);
      assert.deepEqual(events, ['Error: EACCES']);
    } finally {
      await supervisor.close();
    }
  });

  // Kept as a double: a real socket reports a peer's drop as one close, never a close and a failed send together.
  test('a close event and a failed send of one connection count as one loss', async (t) => {
    // Arrange: a connection whose sends fail because its peer is gone.
    const { supervisor, calls, events } = supervised();
    const peer = scriptedPeer<Message, Message>(async () => {
      throw new Error('EPIPE');
    });
    supervisor.open();
    calls[0]!.resolve(peer.connection);
    // The connection must be reported.
    await untilAborted(once(supervisor, 'connected'), t.signal);

    try {
      // Act: the failed send reports the loss first, and the close event comes after it.
      const lost = once(supervisor, 'disconnected');
      supervisor.send({ n: 1 });
      await untilAborted(lost, t.signal);
      peer.drop();

      // Assert
      assert.deepEqual(events, ['connected', 'disconnected']);
      assert.equal(calls.length, 2, 'One loss must start one reconnect');
      assert.equal(peer.closes, 1, 'The lost connection must be closed');
    } finally {
      await supervisor.close();
    }
  });

  // Kept as a double: a real connection is destroyed when it is replaced, so it delivers nothing late.
  test('messages from a replaced connection are ignored', async (t) => {
    // Arrange: the first connection was lost and replaced.
    const { supervisor, calls, events } = supervised();
    const first = scriptedPeer<Message, Message>();
    const second = scriptedPeer<Message, Message>();
    supervisor.open();
    calls[0]!.resolve(first.connection);
    // The connection must be reported.
    await untilAborted(once(supervisor, 'connected'), t.signal);
    first.drop();
    calls[1]!.resolve(second.connection);
    // The replacement must be reported.
    await untilAborted(once(supervisor, 'connected'), t.signal);

    try {
      // Act
      first.deliver({ n: 1 });
      second.deliver({ n: 2 });

      // Assert
      assert.deepEqual(events, [
        'connected',
        'disconnected',
        'connected',
        'message 2',
      ]);
    } finally {
      await supervisor.close();
    }
  });

  // Kept as a double: an adapter that starts unref'd (an IPC channel, a worker port) is handed out once and never replaced.
  test('a replacement keeps the last ref()', async (t) => {
    // Arrange: the open connection was unref'd and then ref'd.
    const { supervisor, calls } = supervised();
    const first = scriptedPeer<Message, Message>();
    const second = scriptedPeer<Message, Message>();
    supervisor.open();
    calls[0]!.resolve(first.connection);
    // The connection must be reported.
    await untilAborted(once(supervisor, 'connected'), t.signal);
    supervisor.unref();
    supervisor.ref();

    try {
      // Act: the connection is lost and replaced.
      first.drop();
      calls[1]!.resolve(second.connection);
      // The replacement must be reported.
      await untilAborted(once(supervisor, 'connected'), t.signal);

      // Assert
      assert.equal(
        second.refs.at(-1),
        'ref',
        'The replacement must keep the process alive, as the last ask said',
      );
    } finally {
      await supervisor.close();
    }
  });

  // Kept as a double: a real connection reports its close later, never inside send().
  test('send reports false while connecting and when the connection drops during the send', async (t) => {
    // Arrange: a connection that drops on every send.
    const { supervisor, calls, events } = supervised();
    const peer = scriptedPeer<Message, Message>(async () => {
      peer.drop();
    });
    supervisor.open();

    try {
      // Act
      const whileConnecting = supervisor.send({ n: 1 });
      calls[0]!.resolve(peer.connection);
      // The connection must be reported.
      await untilAborted(once(supervisor, 'connected'), t.signal);
      const whileDropping = supervisor.send({ n: 2 });

      // Assert
      assert.equal(
        whileConnecting,
        false,
        'Nothing can be sent before a connection is open',
      );
      assert.equal(
        whileDropping,
        false,
        'A send whose connection dropped during it did not reach anyone',
      );
    } finally {
      await supervisor.close();
    }
  });

  // Kept as a double: no public call runs inside the supervisor's 'disconnected' report.
  test('a send made while the loss is reported does not go to the lost connection', async (t) => {
    // Arrange: a listener that sends as soon as it hears of the loss.
    const { connector, calls } = scriptedConnector<Message>();
    const supervisor = new ConnectionSupervisor(connector);
    const first = scriptedPeer<Message, Message>();
    const connected = Promise.withResolvers<void>();
    let duringLoss: { status: string; sent: boolean } | undefined;
    supervisor.once('connected', () => connected.resolve());
    supervisor.on('disconnected', () => {
      duringLoss = {
        status: supervisor.status,
        sent: supervisor.send({ n: 1 }),
      };
    });
    supervisor.open();
    calls[0]!.resolve(first.connection);
    await connected.promise;

    try {
      // Act
      first.drop();

      // Assert
      assert.deepEqual(duringLoss, { status: 'connecting', sent: false });
      assert.deepEqual(first.sent, []);
      await waitFor(
        () => assert.ok(calls.length === 2, 'The supervisor must reconnect'),
        { signal: t.signal },
      );
    } finally {
      await supervisor.close();
    }
  });
});

describe('A process whose supervisor connects over its IPC channel', () => {
  test('a ref() asked after an unref() and before open reaches the first connection, so the process stays alive to hear its parent', async (t) => {
    // Arrange: a process unrefs and then refs its supervisor before it opens it; an IPC connection starts without listening.
    await using waiter = startWorker(
      `
				import { promisify } from 'node:util';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl.href)};
				import { ProcessChannelConnection } from ${JSON.stringify(processChannelConnectionUrl.href)};
				const channel = new ProcessChannelConnection(promisify(process.send).bind(process), { tag: '@test' });
				const supervisor = new ConnectionSupervisor({ connect: async () => channel });
				supervisor.on('connected', () => process.send({ type: 'connected' }));
				supervisor.on('message', (message) => {
					process.send({ type: 'heard', message });
					supervisor.unref();
				});
				supervisor.unref();
				supervisor.ref();
				supervisor.open();
			`,
      'waiter',
    );
    await waiter.next('connected', { signal: t.signal });

    // Act
    // A process that exited first gets no message.
    waiter.child.send({ '@test': { n: 1 } }, () => undefined);

    // Assert: the process heard its parent, and exited by itself after its unref().
    const heard = await waiter.next('heard', { signal: t.signal });
    assert.deepEqual(heard.message, { n: 1 });
    await untilAborted(waiter.closed, t.signal);
    assert.deepEqual(waiter.exit, { code: 0, signal: null }, waiter.stderr);
  });
});
