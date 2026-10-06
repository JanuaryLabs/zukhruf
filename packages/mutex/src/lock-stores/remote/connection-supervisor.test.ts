import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
  const { connector, calls } = scriptedConnector<Message, Message>();
  const supervisor = new ConnectionSupervisor(connector);
  const events: string[] = [];
  supervisor.on('connected', () => events.push('connected'));
  supervisor.on('message', ({ n }) => events.push(`message ${n}`));
  supervisor.on('disconnected', () => events.push('disconnected'));
  supervisor.on('unavailable', () => events.push('unavailable'));
  supervisor.on('failed', (error) => events.push(`failed: ${String(error)}`));
  return { supervisor, calls, events };
}

describe('Connection supervisor', () => {
  test('nothing connects until the supervisor is opened, and opening twice connects once', async () => {
    // Arrange
    const { supervisor, calls } = supervised();
    const beforeOpen = calls.length;

    try {
      // Act
      supervisor.open();
      supervisor.open();

      // Assert
      assert.equal(
        beforeOpen,
        0,
        'A supervisor must not connect before it is opened',
      );
      assert.equal(calls.length, 1, 'Opening twice must connect once');
      assert.equal(supervisor.status, 'connecting');
    } finally {
      await supervisor.close();
    }
  });

  test('an open connection is reported, and carries messages both ways', async (t) => {
    // Arrange
    const { supervisor, calls, events } = supervised();
    const peer = scriptedPeer<Message, Message>();
    supervisor.open();

    try {
      // Act
      calls[0]!.resolve(peer.connection);
      await waitUntil(
        t,
        () => events.includes('connected'),
        'The connection must be reported',
      );
      const sent = supervisor.send({ n: 1 });
      peer.deliver({ n: 2 });

      // Assert
      assert.equal(sent, true);
      assert.deepEqual(peer.sent, [{ n: 1 }]);
      assert.deepEqual(events, ['connected', 'message 2']);
      assert.equal(supervisor.status, 'connected');
    } finally {
      await supervisor.close();
    }
  });

  test('a connection that opens as the supervisor closes is closed and never reported', async () => {
    // Arrange
    const { supervisor, calls, events } = supervised();
    const peer = scriptedPeer<Message, Message>();
    supervisor.open();

    // Act: the connection arrives in the same turn as the close.
    calls[0]!.resolve(peer.connection);
    await supervisor.close();

    // Assert
    assert.equal(peer.closes, 1, 'The late connection must be closed');
    assert.deepEqual(
      events,
      [],
      'A closed supervisor must not report anything',
    );
    assert.equal(supervisor.status, 'closed');
  });

  test('closing while connecting aborts the connect, and finishes only after it settles', async (t) => {
    // Arrange: a connector that settles only when the test says so.
    const connecting = Promise.withResolvers<undefined>();
    let signal: AbortSignal | undefined;
    const supervisor = new ConnectionSupervisor<Message, Message>({
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

  test('a connector with no coordinator left makes the supervisor unavailable for good', async (t) => {
    // Arrange
    const { supervisor, calls, events } = supervised();
    supervisor.open();

    try {
      // Act
      calls[0]!.resolve(undefined);
      await waitUntil(
        t,
        () => events.length > 0,
        'The outcome must be reported',
      );
      supervisor.open();

      // Assert
      assert.deepEqual(events, ['unavailable']);
      assert.equal(supervisor.status, 'unavailable');
      assert.equal(
        calls.length,
        1,
        'An unavailable supervisor must not ask the connector again',
      );
    } finally {
      await supervisor.close();
    }
  });

  test('a connector that fails is reported, and the next open connects again', async (t) => {
    // Arrange
    const { supervisor, calls, events } = supervised();
    supervisor.open();

    try {
      // Act
      calls[0]!.reject(new Error('EACCES'));
      await waitUntil(
        t,
        () => events.length > 0,
        'The failure must be reported',
      );
      const statusAfterFailure = supervisor.status;
      supervisor.open();

      // Assert
      assert.deepEqual(events, ['failed: Error: EACCES']);
      assert.equal(statusAfterFailure, 'idle');
      assert.equal(
        calls.length,
        2,
        'Opening after a failure must connect again',
      );
    } finally {
      await supervisor.close();
    }
  });

  test('a connector that throws before it returns a promise is reported as failed', async (t) => {
    // Arrange
    const events: string[] = [];
    const supervisor = new ConnectionSupervisor<Message, Message>({
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

  test('a send made while the loss is reported does not go to the lost connection', async (t) => {
    // Arrange: a listener that sends as soon as it hears of the loss.
    const { connector, calls } = scriptedConnector<Message, Message>();
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

  test('ref and unref reach the open connection, and nothing else touches it', async (t) => {
    // Arrange
    const { supervisor, calls, events } = supervised();
    const peer = scriptedPeer<Message, Message>();
    supervisor.ref();
    supervisor.open();
    calls[0]!.resolve(peer.connection);
    await waitUntil(
      t,
      () => events.includes('connected'),
      'The connection must be reported',
    );

    try {
      // Act
      supervisor.ref();
      supervisor.unref();

      // Assert: a ref before the connection opened reaches nothing; its listener applies it on `connected`.
      assert.deepEqual(peer.refs, ['ref', 'unref']);
    } finally {
      await supervisor.close();
    }
  });

  test('closing closes the open connection and reports nothing more', async (t) => {
    // Arrange
    const { supervisor, calls, events } = supervised();
    const peer = scriptedPeer<Message, Message>();
    supervisor.open();
    calls[0]!.resolve(peer.connection);
    await waitUntil(
      t,
      () => events.includes('connected'),
      'The connection must be reported',
    );

    // Act
    await supervisor.close();
    peer.drop();
    supervisor.open();

    // Assert
    assert.equal(peer.closes, 1);
    assert.deepEqual(events, ['connected']);
    assert.equal(supervisor.status, 'closed');
    assert.equal(supervisor.send({ n: 1 }), false);
    assert.equal(calls.length, 1, 'A closed supervisor must not connect again');
  });
});
