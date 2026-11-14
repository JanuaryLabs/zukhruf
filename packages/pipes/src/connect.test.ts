import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { PipeAddress, PipeEndpoint } from './index.ts';
import { defaultFolder } from './testing/default-folder.ts';

const posixOnly = process.platform === 'win32' ? 'a Unix socket path' : false;

describe('address.connect', { skip: posixOnly }, () => {
  test('rejects with ENOENT when nothing is at the path', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const address = new PipeAddress(join(scratch.path, 'absent.sock'));

    // Act
    const connecting = address.connect();

    // Assert
    await assert.rejects(connecting, { code: 'ENOENT' });
  });

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
