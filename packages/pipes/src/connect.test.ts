import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { NoServerError, PipeAddress, PipeEndpoint } from './index.ts';
import { defaultFolder } from './testing/default-folder.ts';
import { packageIndex, startProgram } from './testing/program.ts';

const posixOnly = process.platform === 'win32' ? 'a Unix socket path' : false;
const linuxOnly =
  process.platform === 'linux'
    ? false
    : 'only Linux resets a connection that its server did not accept';
const notRoot =
  posixOnly ||
  (process.getuid?.() === 0 ? 'root ignores the mode of a socket' : false);

/** The code of the error of Node.js under a `NoServerError`. */
function noServerCode(error: unknown): unknown {
  assert.ok(error instanceof NoServerError, String(error));
  return Reflect.get(Object(error.cause), 'code');
}

/**
 * Blocks this process until Linux has released each socket bound to `path`,
 * as /proc/net/unix lists them. A killed process's state is not that fact: its
 * main thread is a zombie before its other threads close its files. The block
 * keeps Node from reading the result of a connect meanwhile.
 */
function blockUntilReleased(path: string): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 10_000; waited += 1) {
    const sockets = readFileSync('/proc/net/unix', 'utf8').split('\n');
    if (!sockets.some((line) => line.endsWith(` ${path}`))) return;
    Atomics.wait(pause, 0, 0, 1);
  }
  throw new Error(`Linux did not release the socket ${path} within 10 s`);
}

describe('address.connect', { skip: posixOnly }, () => {
  test('rejects with NoServerError when nothing is at the path; its cause is ENOENT', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const address = new PipeAddress(join(scratch.path, 'absent.sock'));

    // Act
    const error = await address.connect().catch((reason: unknown) => reason);

    // Assert
    assert.equal(noServerCode(error), 'ENOENT');
    assert.ok(error instanceof NoServerError);
    assert.equal(error.path, address.path);
  });

  test(
    'rejects with NoServerError when the server dies before it accepts the connection; its cause is ECONNRESET on Linux',
    { skip: linuxOnly },
    async (t) => {
      // Arrange: the server's program listens, then blocks, so it accepts nothing.
      await using folder = defaultFolder();
      const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
      await using frozen =
        startProgram(`import { PipeEndpoint } from ${JSON.stringify(packageIndex)};
await new PipeEndpoint('greeter', { prefix: ${JSON.stringify(folder.prefix)} }).listen(() => {});
console.log('listening');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);`);
      await frozen.printed('listening', { signal: t.signal });

      // Act: the server dies after the kernel queued the connection and before Node reads the result.
      const connecting = endpoint.address.connect();
      frozen.child.kill('SIGKILL');
      blockUntilReleased(endpoint.address.path);
      const error = await connecting.catch((reason: unknown) => reason);

      // Assert
      assert.equal(noServerCode(error), 'ECONNRESET');
    },
  );

  test('rejects with NoServerError when a file that is not a socket is at the path', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const path = join(scratch.path, 'plain.sock');
    await writeFile(path, '');

    // Act
    const error = await new PipeAddress(path)
      .connect()
      .catch((reason: unknown) => reason);

    // Assert: macOS says ENOTSOCK, Linux refuses it as a leftover file.
    assert.equal(
      noServerCode(error),
      process.platform === 'darwin' ? 'ENOTSOCK' : 'ECONNREFUSED',
    );
  });

  test(
    'rejects with the EACCES of Node.js, not NoServerError, when this user may not write the socket of a live server',
    { skip: notRoot },
    async () => {
      // Arrange: a live server whose socket file this user may not write, as another user's is.
      await using folder = defaultFolder();
      const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
      await using _server = await endpoint.listen(() => {});
      await chmod(endpoint.address.path, 0o000);

      // Act
      const error = await endpoint.address
        .connect()
        .catch((reason: unknown) => reason);

      // Assert
      assert.ok(!(error instanceof NoServerError));
      assert.equal(Reflect.get(Object(error), 'code'), 'EACCES');
    },
  );

  test('rejects with ABORT_ERR when the signal has aborted', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
    await using _server = await endpoint.listen(() => {});

    // Act
    const connecting = endpoint.address.connect({
      signal: AbortSignal.abort(),
    });

    // Assert
    await assert.rejects(connecting, { code: 'ABORT_ERR' });
  });

  test('an abort after the connect destroys the socket', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
    await using _server = await endpoint.listen(() => {});
    const controller = new AbortController();
    const socket = await endpoint.address.connect({
      signal: controller.signal,
    });
    const errors: unknown[] = [];
    socket.on('error', (error) => errors.push(error));
    const closed = new Promise((resolve) => socket.once('close', resolve));

    // Act
    controller.abort();
    await closed;

    // Assert
    assert.ok(socket.destroyed);
    assert.deepEqual(
      errors.map((error) => Reflect.get(Object(error), 'code')),
      ['ABORT_ERR'],
    );
  });
});

describe('new PipeAddress', () => {
  test('keeps the published path as it is and checks nothing', () => {
    // Arrange
    const path = `relative/${'g'.repeat(300)}`;

    // Act
    const address = new PipeAddress(path);

    // Assert
    assert.equal(address.path, path);
  });
});
