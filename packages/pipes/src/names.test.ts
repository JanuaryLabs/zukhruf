import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { PipeEndpoint } from './index.ts';
import { defaultFolder } from './testing/default-folder.ts';

const posixOnly = process.platform === 'win32' ? 'a Unix socket path' : false;
const windowsOnly =
  process.platform === 'win32' ? false : 'a named pipe of Windows (#4340)';

/** One byte less than sun_path: 103 bytes on macOS, 107 on Linux (ADR 0004). */
const limit = process.platform === 'linux' ? 107 : 103;

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (reason: unknown) => reason,
  );
  return Reflect.get(Object(error), 'code');
}

function tooLong(path: string): RegExp {
  return new RegExp(
    `^The socket path ${RegExp.escape(path)} is ${limit + 1} bytes, more than ${limit}; choose a shorter folder or name\\.$`,
  );
}

describe('the length of a socket path', { skip: posixOnly }, () => {
  test(`a path of ${limit} bytes listens and connects; one of ${limit + 1} bytes is a RangeError and makes no file`, async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const folder = `${scratch.path}/`;
    const atLimit = folder + 'a'.repeat(limit - folder.length);
    const overLimit = folder + 'b'.repeat(limit + 1 - folder.length);

    // Act
    const endpoint = new PipeEndpoint(atLimit, { prefix: 'unused' });
    await using _server = await endpoint.listen((socket) => socket.end());
    const socket = await endpoint.address.connect();
    socket.destroy();

    // Assert
    assert.equal(Buffer.byteLength(endpoint.address.path), limit);
    assert.throws(
      () => new PipeEndpoint(overLimit, { prefix: 'unused' }),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, tooLong(overLimit));
        return true;
      },
    );
    assert.equal(await codeOf(lstat(overLimit)), 'ENOENT');
  });

  test('counts UTF-8 bytes, not characters', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const folder = `${scratch.path}/`;
    const name = folder + 'é'.repeat(2) + 'c'.repeat(limit - 3 - folder.length);

    // Act
    const making = () => new PipeEndpoint(name, { prefix: 'unused' });

    // Assert
    assert.equal(name.length, limit - 1);
    assert.throws(making, (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, tooLong(name));
      return true;
    });
  });

  test('counts the path as it is given, not as it resolves', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const folder = `${scratch.path}/./`;
    const name = folder + 'd'.repeat(limit + 1 - folder.length);

    // Act
    const making = () => new PipeEndpoint(name, { prefix: 'unused' });

    // Assert
    assert.throws(making, (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, tooLong(name));
      return true;
    });
  });

  test('a plain name whose path in the default folder is too long is a RangeError, and no folder is made', async () => {
    // Arrange
    await using folder = defaultFolder();
    const name = 'e'.repeat(limit + 1 - `${folder.path}/`.length);

    // Act
    const making = () => new PipeEndpoint(name, { prefix: folder.prefix });

    // Assert
    assert.throws(making, (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, tooLong(join(folder.path, name)));
      return true;
    });
    assert.equal(await codeOf(lstat(folder.path)), 'ENOENT');
  });
});

describe('a name or a prefix that is not one file name', () => {
  const broken = ['', '.', '..', 'a/b', '../x', 'a\\b', 'a\0b'];
  for (const value of broken) {
    test(`the name ${JSON.stringify(value)} is a TypeError that names it`, () => {
      // Act
      const making = () => new PipeEndpoint(value, { prefix: 'example' });

      // Assert
      assert.throws(making, (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.ok(
          error.message.startsWith(
            `The name ${JSON.stringify(value)} is not one file name`,
          ),
        );
        assert.match(
          error.message,
          /must not be empty, "\." or "\.\.", and must have no "\/", no "\\" and no zero byte/,
        );
        return true;
      });
    });

    test(`the prefix ${JSON.stringify(value)} is a TypeError that names it`, () => {
      // Act
      const making = () => new PipeEndpoint('greeter', { prefix: value });

      // Assert
      assert.throws(making, (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.ok(
          error.message.startsWith(
            `The prefix ${JSON.stringify(value)} is not one file name`,
          ),
        );
        return true;
      });
    });
  }

  test(
    'a name with dots inside it is one file name',
    { skip: posixOnly },
    () => {
      // Act
      const endpoint = new PipeEndpoint('..greeter.sock', { prefix: 'a.b' });

      // Assert
      assert.equal(
        endpoint.address.path,
        `/tmp/a.b-${process.getuid!()}/..greeter.sock`,
      );
    },
  );
});

describe('a name on Windows', { skip: windowsOnly }, () => {
  test('a plain name is the pipe \\\\.\\pipe\\<prefix>-<name>', () => {
    // Act
    const endpoint = new PipeEndpoint('greeter', { prefix: 'example' });

    // Assert
    assert.equal(endpoint.address.path, '\\\\.\\pipe\\example-greeter');
  });

  test('a rooted name is a pipe named by the hash of its lowercased resolved path, so case does not matter', () => {
    // Arrange
    const name = 'C:\\Users\\Someone\\Locks\\lock.sock';
    const id = '2bb33ebd2002b946802bf7ce0aa80d8b';

    // Act
    const upper = new PipeEndpoint(name, { prefix: 'example' });
    const lower = new PipeEndpoint(name.toLowerCase(), { prefix: 'example' });

    // Assert
    assert.equal(upper.address.path, `\\\\.\\pipe\\example-${id}`);
    assert.equal(lower.address.path, upper.address.path);
  });

  test('the length of a pipe name is not checked', () => {
    // Act
    const endpoint = new PipeEndpoint('f'.repeat(200), { prefix: 'example' });

    // Assert
    assert.equal(
      endpoint.address.path,
      `\\\\.\\pipe\\example-${'f'.repeat(200)}`,
    );
  });
});
