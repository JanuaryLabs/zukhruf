import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { startWorker } from '@zukhruf/testing/process';

import { standInServer } from '../testing/stand-in-server.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';
import type { Connection, ConnectionEvents } from './connection.ts';

const supervisorUrl = new URL('./connection-supervisor.ts', import.meta.url);
const socketConnectionUrl = new URL('./socket-connection.ts', import.meta.url);

describe('Connection supervisor', () => {
  // Kept as a double: this package's only adapter, a socket, starts ref'd, so only a stand-in shows a replacement that must be ref'd.
  test('a replacement keeps the last ref()', async (t) => {
    // Arrange: two connections that record each ref and unref; the first is open, and was unref'd and then ref'd.
    const asked: ('ref' | 'unref')[][] = [[], []];
    const [first, second] = asked.map((calls): Connection<unknown> =>
      Object.assign(new EventEmitter<ConnectionEvents>(), {
        send: async () => {},
        ref: () => calls.push('ref'),
        unref: () => calls.push('unref'),
        close: () => {},
      }),
    );
    const waiting = [first, second];
    const supervisor = new ConnectionSupervisor<unknown>({
      connect: async () => waiting.shift(),
    });
    const connected = once(supervisor, 'connected');
    supervisor.open();
    // The connection must be reported.
    await untilAborted(connected, t.signal);
    supervisor.unref();
    supervisor.ref();

    try {
      // Act: the connection is lost and replaced.
      const replaced = once(supervisor, 'connected');
      first!.emit('close');
      // The replacement must be reported.
      await untilAborted(replaced, t.signal);

      // Assert
      assert.equal(
        asked[1]!.at(-1),
        'ref',
        'The replacement must keep the process alive, as the last ask said',
      );
    } finally {
      await supervisor.close();
    }
  });
});

/** Where a server of the test listens: a socket file in `directory`, or a named pipe on Windows. */
function socketPathIn(directory: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\single-flight-test-${randomUUID()}`
    : join(directory, 'peer.sock');
}

describe('A process whose supervisor connects over a socket', () => {
  test('an unref() asked before open reaches the first connection, so the process exits by itself', async (t) => {
    // Arrange: a process unrefs its supervisor before it opens it, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath = socketPathIn(directory.path);
    await using _server = await standInServer(socketPath, () => {});
    await using idle = startWorker(
      `
				import { connect } from 'node:net';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl.href)};
				import { SocketConnection } from ${JSON.stringify(socketConnectionUrl.href)};
				process.once('message', () => {});
				const supervisor = new ConnectionSupervisor({
					connect: (signal) => new Promise((resolve, reject) => {
						const socket = connect({ path: ${JSON.stringify(socketPath)}, signal });
						socket.once('connect', () => resolve(new SocketConnection(socket)));
						socket.once('error', reject);
					}),
				});
				supervisor.on('connected', () => process.send({ type: 'connected' }));
				supervisor.unref();
				supervisor.open();
			`,
      'idle',
    );
    await idle.next('connected', { signal: t.signal });

    // Act: the process has nothing else to do.
    // A process that exited first gets no message.
    idle.child.send('done', () => undefined);

    // Assert: the first connection keeps the unref() asked before it opened.
    await untilAborted(idle.closed, t.signal);
    assert.deepEqual(idle.exit, { code: 0, signal: null }, idle.stderr);
  });

  test('after unref(), the process exits by itself once its lost socket connection was replaced', async (t) => {
    // Arrange: a process unrefs its supervisor on the first connection, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath = socketPathIn(directory.path);
    const firstPeer = Promise.withResolvers<Socket>();
    await using _server = await standInServer(socketPath, (peer) =>
      firstPeer.resolve(peer),
    );
    await using idle = startWorker(
      `
				import { connect } from 'node:net';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl.href)};
				import { SocketConnection } from ${JSON.stringify(socketConnectionUrl.href)};
				process.once('message', () => {});
				const supervisor = new ConnectionSupervisor({
					connect: (signal) => new Promise((resolve, reject) => {
						const socket = connect({ path: ${JSON.stringify(socketPath)}, signal });
						socket.once('connect', () => resolve(new SocketConnection(socket)));
						socket.once('error', reject);
					}),
				});
				supervisor.once('connected', () => {
					supervisor.unref();
					supervisor.on('connected', () => process.send({ type: 'replaced' }));
					process.send({ type: 'unrefed' });
				});
				supervisor.open();
			`,
      'idle',
    );
    await idle.next('unrefed', { signal: t.signal });

    // Act: the server drops the connection, the supervisor replaces it, and the process has nothing else to do.
    (await untilAborted(firstPeer.promise, t.signal)).destroy();
    await idle.next('replaced', { signal: t.signal });
    // A process that exited first gets no message.
    idle.child.send('done', () => undefined);

    // Assert: the replacement keeps the last unref(), so it does not keep the process alive.
    await untilAborted(idle.closed, t.signal);
    assert.deepEqual(idle.exit, { code: 0, signal: null }, idle.stderr);
  });

  test('an unref() asked while the supervisor reconnects reaches the replacement, so the process exits by itself', async (t) => {
    // Arrange: a process unrefs its supervisor when it hears of the loss, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath = socketPathIn(directory.path);
    const firstPeer = Promise.withResolvers<Socket>();
    await using _server = await standInServer(socketPath, (peer) =>
      firstPeer.resolve(peer),
    );
    await using idle = startWorker(
      `
				import { connect } from 'node:net';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl.href)};
				import { SocketConnection } from ${JSON.stringify(socketConnectionUrl.href)};
				process.once('message', () => {});
				const supervisor = new ConnectionSupervisor({
					connect: (signal) => new Promise((resolve, reject) => {
						const socket = connect({ path: ${JSON.stringify(socketPath)}, signal });
						socket.once('connect', () => resolve(new SocketConnection(socket)));
						socket.once('error', reject);
					}),
				});
				supervisor.once('connected', () => {
					supervisor.on('connected', () => process.send({ type: 'replaced' }));
					process.send({ type: 'connected' });
				});
				// The supervisor reports the loss once it is connecting again.
				supervisor.once('disconnected', () => supervisor.unref());
				supervisor.open();
			`,
      'idle',
    );
    await idle.next('connected', { signal: t.signal });

    // Act: the server drops the connection, the supervisor replaces it, and the process has nothing else to do.
    (await untilAborted(firstPeer.promise, t.signal)).destroy();
    await idle.next('replaced', { signal: t.signal });
    // A process that exited first gets no message.
    idle.child.send('done', () => undefined);

    // Assert: the replacement keeps the unref() asked while there was no connection.
    await untilAborted(idle.closed, t.signal);
    assert.deepEqual(idle.exit, { code: 0, signal: null }, idle.stderr);
  });
});
