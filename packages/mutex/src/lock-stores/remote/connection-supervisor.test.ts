import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { isRecord } from '../../shared/is-record.ts';
import {
  scriptedConnector,
  scriptedPeer,
} from '../../testing/scripted-peer.ts';
import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { watch } from '../../testing/watch.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';

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
    const closing = watch(supervisor.close());
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
    await waitUntil(
      t,
      () => closing.now.status === 'fulfilled',
      'Close must finish once the connect settles',
    );
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
      supervisor.open();

      // Assert
      await waitUntil(
        t,
        () => events.length > 0,
        'The failure must be reported',
      );
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
    await waitUntil(
      t,
      () => events.includes('connected'),
      'The connection must be reported',
    );

    try {
      // Act
      supervisor.send({ n: 1 });
      peer.drop();
      await delay(settle);

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
    await waitUntil(
      t,
      () => events.includes('connected'),
      'The connection must be reported',
    );
    first.drop();
    calls[1]!.resolve(second.connection);
    await waitUntil(
      t,
      () => events.filter((event) => event === 'connected').length === 2,
      'The replacement must be reported',
    );

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
      await waitUntil(
        t,
        () => events.includes('connected'),
        'The connection must be reported',
      );
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
      await waitUntil(
        t,
        () => calls.length === 2,
        'The supervisor must reconnect',
      );
    } finally {
      await supervisor.close();
    }
  });
});
