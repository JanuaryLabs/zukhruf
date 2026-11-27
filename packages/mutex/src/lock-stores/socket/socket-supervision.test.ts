import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { startWorker } from '@zukhruf/testing/process';

import { standInServer } from '../../testing/stand-in-server.ts';

const supervisorUrl = import.meta.resolve('@zukhruf/rpc');
const socketConnectionUrl = new URL('./socket-connection.ts', import.meta.url);

/** Where a server of the test listens: a socket file in `directory`, or a named pipe on Windows. */
function socketPathIn(directory: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\mutex-test-${randomUUID()}`
    : join(directory, 'peer.sock');
}

describe('A process whose supervisor connects over a socket', () => {
  test('a supervisor that nobody holds lets the process exit by itself once its first connection is open', async (t) => {
    // Arrange: a process opens its supervisor without a hold, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const socketPath = socketPathIn(directory.path);
    await using _server = await standInServer(socketPath, () => {});
    await using idle = startWorker(
      `
				import { connect } from 'node:net';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl)};
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
				supervisor.open();
			`,
      'idle',
    );
    await idle.next('connected', { signal: t.signal });

    // Act: the process has nothing else to do.
    // A process that exited first gets no message.
    idle.child.send('done', () => undefined);

    // Assert: the first connection is not ref'd, because nobody holds the supervisor.
    await untilAborted(idle.closed, t.signal);
    assert.deepEqual(idle.exit, { code: 0, signal: null }, idle.stderr);
  });

  test('after its last hold is released, the process exits by itself once its lost socket connection was replaced', async (t) => {
    // Arrange: a process holds its supervisor until the first connection, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const socketPath = socketPathIn(directory.path);
    const firstPeer = Promise.withResolvers<Socket>();
    await using _server = await standInServer(socketPath, (peer) =>
      firstPeer.resolve(peer),
    );
    await using idle = startWorker(
      `
				import { connect } from 'node:net';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl)};
				import { SocketConnection } from ${JSON.stringify(socketConnectionUrl.href)};
				process.once('message', () => {});
				const supervisor = new ConnectionSupervisor({
					connect: (signal) => new Promise((resolve, reject) => {
						const socket = connect({ path: ${JSON.stringify(socketPath)}, signal });
						socket.once('connect', () => resolve(new SocketConnection(socket)));
						socket.once('error', reject);
					}),
				});
				const held = supervisor.hold();
				supervisor.once('connected', () => {
					held[Symbol.dispose]();
					supervisor.on('connected', () => process.send({ type: 'replaced' }));
					process.send({ type: 'released' });
				});
				supervisor.open();
			`,
      'idle',
    );
    await idle.next('released', { signal: t.signal });

    // Act: the server drops the connection, the supervisor replaces it, and the process has nothing else to do.
    (await untilAborted(firstPeer.promise, t.signal)).destroy();
    await idle.next('replaced', { signal: t.signal });
    // A process that exited first gets no message.
    idle.child.send('done', () => undefined);

    // Assert: nobody holds the supervisor, so the replacement does not keep the process alive.
    await untilAborted(idle.closed, t.signal);
    assert.deepEqual(idle.exit, { code: 0, signal: null }, idle.stderr);
  });

  test('a hold released while the supervisor reconnects reaches the replacement, so the process exits by itself', async (t) => {
    // Arrange: a process holds its supervisor until it hears of the loss, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const socketPath = socketPathIn(directory.path);
    const firstPeer = Promise.withResolvers<Socket>();
    await using _server = await standInServer(socketPath, (peer) =>
      firstPeer.resolve(peer),
    );
    await using idle = startWorker(
      `
				import { connect } from 'node:net';
				import { ConnectionSupervisor } from ${JSON.stringify(supervisorUrl)};
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
				const held = supervisor.hold();
				// The supervisor reports the loss once it is connecting again.
				supervisor.once('disconnected', () => held[Symbol.dispose]());
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

    // Assert: the replacement keeps the release made while there was no connection.
    await untilAborted(idle.closed, t.signal);
    assert.deepEqual(idle.exit, { code: 0, signal: null }, idle.stderr);
  });
});
