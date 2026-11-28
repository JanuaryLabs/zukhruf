import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { NodeCommand } from '@zukhruf/process';

import { standInServer } from '../testing/stand-in-server.ts';

const supervisorUrl = import.meta.resolve('@zukhruf/rpc');
const socketConnectionUrl = new URL('./socket-connection.ts', import.meta.url);

/** Where a server of the test listens: a socket file in `directory`, or a named pipe on Windows. */
function socketPathIn(directory: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\single-flight-test-${randomUUID()}`
    : join(directory, 'peer.sock');
}

describe('A process whose supervisor connects over a socket', () => {
  test('a supervisor that nobody holds lets the process exit by itself once its first connection is open', async (t) => {
    // Arrange: a process opens its supervisor without a hold, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath = socketPathIn(directory.path);
    await using _server = await standInServer(socketPath, () => {});
    await using idle = await new NodeCommand(
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
      { name: 'idle', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'connected' }, signal: t.signal });

    // Act: the process has nothing else to do.
    idle.send({ type: 'done' });

    // Assert: the first connection is not ref'd, because nobody holds the supervisor.
    const end = await untilAborted(idle.process.ended, t.signal);
    assert.deepEqual(end, { exitCode: 0 }, idle.process.stderrTail());
  });

  test('after its last hold is released, the process exits by itself once its lost socket connection was replaced', async (t) => {
    // Arrange: a process holds its supervisor until the first connection, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath = socketPathIn(directory.path);
    const firstPeer = Promise.withResolvers<Socket>();
    await using _server = await standInServer(socketPath, (peer) =>
      firstPeer.resolve(peer),
    );
    await using idle = await new NodeCommand(
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
      { name: 'idle', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'released' }, signal: t.signal });

    // Act: the server drops the connection, the supervisor replaces it, and the process has nothing else to do.
    (await untilAborted(firstPeer.promise, t.signal)).destroy();
    await idle.next('replaced', { signal: t.signal });
    idle.send({ type: 'done' });

    // Assert: nobody holds the supervisor, so the replacement does not keep the process alive.
    const end = await untilAborted(idle.process.ended, t.signal);
    assert.deepEqual(end, { exitCode: 0 }, idle.process.stderrTail());
  });

  test('a hold released while the supervisor reconnects reaches the replacement, so the process exits by itself', async (t) => {
    // Arrange: a process holds its supervisor until it hears of the loss, and stays alive only until the test says so.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath = socketPathIn(directory.path);
    const firstPeer = Promise.withResolvers<Socket>();
    await using _server = await standInServer(socketPath, (peer) =>
      firstPeer.resolve(peer),
    );
    await using idle = await new NodeCommand(
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
      { name: 'idle', env: process.env, clock: globalThis },
    ).start({ ready: { message: 'connected' }, signal: t.signal });

    // Act: the server drops the connection, the supervisor replaces it, and the process has nothing else to do.
    (await untilAborted(firstPeer.promise, t.signal)).destroy();
    await idle.next('replaced', { signal: t.signal });
    idle.send({ type: 'done' });

    // Assert: the replacement keeps the release made while there was no connection.
    const end = await untilAborted(idle.process.ended, t.signal);
    assert.deepEqual(end, { exitCode: 0 }, idle.process.stderrTail());
  });
});
