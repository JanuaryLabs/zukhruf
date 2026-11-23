import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  NoServerError,
  PipeAddress,
  PipeEndpoint,
  type PipeServer,
  UnsafeFolderError,
} from './index.ts';
import { defaultFolder } from './testing/default-folder.ts';
import { packageIndex, startProgram } from './testing/program.ts';

const posixOnly =
  process.platform === 'win32' ? 'a Unix socket file and its folder' : false;
const notRoot =
  posixOnly ||
  (process.getuid?.() === 0 ? 'root ignores the mode of a folder' : false);

/** A program that listens on `name` and prints `listening`; each client gets `hello`. */
function listenerSource(name: string, prefix: string): string {
  return `import { PipeEndpoint } from ${JSON.stringify(packageIndex)};
await new PipeEndpoint(${JSON.stringify(name)}, { prefix: ${JSON.stringify(prefix)} }).listen((socket) => socket.end('hello'));
console.log('listening');`;
}

async function read(address: PipeAddress): Promise<string> {
  const socket = await address.connect();
  socket.setEncoding('utf8');
  let text = '';
  for await (const chunk of socket) text += String(chunk);
  return text;
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => assert.fail('expected a rejection'),
    (reason: unknown) => reason,
  );
  return Reflect.get(Object(error), 'code');
}

/** The code of the error of Node.js under the `NoServerError` that `connecting` rejects with. */
async function noServerCode(connecting: Promise<unknown>): Promise<unknown> {
  const error = await connecting.then(
    () => assert.fail('expected a rejection'),
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof NoServerError, String(error));
  return Reflect.get(Object(error.cause), 'code');
}

describe(
  'endpoint.listen after a server was killed',
  { skip: posixOnly },
  () => {
    test('the killed server leaves its file, a connect is refused and leaves it, and the next listen on the plain name removes it and serves', async (t) => {
      // Arrange
      await using folder = defaultFolder();
      const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
      // A connection that the server has not accepted yet is reset by Linux when the server dies, so the client waits for `accepted`.
      await using killed =
        startProgram(`import { PipeEndpoint } from ${JSON.stringify(packageIndex)};
await new PipeEndpoint('greeter', { prefix: ${JSON.stringify(folder.prefix)} }).listen(() => console.log('accepted'));
console.log('listening');`);
      await killed.printed('listening', { signal: t.signal });
      const before = await lstat(folder.path);
      const client = connect(endpoint.address.path);
      await once(client, 'connect');
      await killed.printed('accepted', { signal: t.signal });
      const events: string[] = [];
      client.on('data', () => {});
      client.once('end', () => events.push('end'));
      const clientClosed = once(client, 'close').then(() =>
        events.push('close'),
      );
      killed.child.kill('SIGKILL');
      await killed.exited({ signal: t.signal });
      await clientClosed;

      // Act
      const refused = await noServerCode(endpoint.address.connect());
      const leftover = await lstat(endpoint.address.path);
      await using server = await endpoint.listen((socket) =>
        socket.end('again'),
      );

      // Assert
      assert.deepEqual(events, ['end', 'close']);
      assert.equal(refused, 'ECONNREFUSED');
      assert.ok(leftover.isSocket());
      assert.equal(await read(endpoint.address), 'again');
      const after = await lstat(folder.path);
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode & 0o777, 0o700);
      assert.equal(server.endpoint, endpoint);
    });

    test('the next listen on a rooted name removes the leftover file and serves', async (t) => {
      // Arrange
      await using scratch = await new TemporaryFiles().directory('pipes-', {
        parent: '/tmp',
      });
      const name = join(scratch.path, 'lock.sock');
      const endpoint = new PipeEndpoint(name, { prefix: 'unused' });
      {
        await using killed = startProgram(listenerSource(name, 'unused'));
        await killed.printed('listening', { signal: t.signal });
        killed.child.kill('SIGKILL');
        await killed.exited({ signal: t.signal });
      }
      assert.equal(
        await noServerCode(endpoint.address.connect()),
        'ECONNREFUSED',
      );

      // Act
      await using _server = await endpoint.listen((socket) =>
        socket.end('again'),
      );

      // Assert
      assert.equal(await read(endpoint.address), 'again');
    });
  },
);

describe('a client of another program', { skip: posixOnly }, () => {
  test('connects to the published path and reads what the server wrote', async (t) => {
    // Arrange
    await using folder = defaultFolder();
    await using _server = await new PipeEndpoint('greeter', {
      prefix: folder.prefix,
    }).listen((socket) => socket.end('hello from the server'));
    const path = `${folder.path}/greeter`;

    // Act
    await using client =
      startProgram(`import { PipeAddress } from ${JSON.stringify(packageIndex)};
const socket = await new PipeAddress(${JSON.stringify(path)}).connect();
socket.setEncoding('utf8');
let text = '';
for await (const chunk of socket) text += chunk;
console.log(text);`);

    // Assert
    await client.printed('hello from the server', { signal: t.signal });
  });
});

describe('the default folder of a plain name', { skip: posixOnly }, () => {
  test('is /tmp/<prefix>-<uid>, made by listen with mode 0700 for this user, not by the constructor', async () => {
    // Arrange
    await using folder = defaultFolder();

    // Act
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
    const beforeListen = await codeOf(lstat(folder.path));
    await using _server = await endpoint.listen(() => {});

    // Assert
    assert.equal(
      endpoint.address.path,
      `/tmp/${folder.prefix}-${process.getuid!()}/greeter`,
    );
    assert.equal(beforeListen, 'ENOENT');
    const made = await lstat(folder.path);
    assert.ok(made.isDirectory());
    assert.equal(made.mode & 0o777, 0o700);
    assert.equal(made.uid, process.getuid!());
    assert.ok((await lstat(endpoint.address.path)).isSocket());
  });

  for (const mode of [0o740, 0o720, 0o710, 0o704, 0o702, 0o701]) {
    test(`is refused with mode 0${mode.toString(8)}: it gives access to its group or others`, async () => {
      // Arrange
      await using folder = defaultFolder();
      await mkdir(folder.path);
      await chmod(folder.path, mode);
      const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });

      // Act
      const listening = endpoint.listen(() => {});

      // Assert
      await assert.rejects(listening, (error: unknown) => {
        assert.ok(error instanceof UnsafeFolderError);
        assert.equal(error.name, 'UnsafeFolderError');
        assert.equal(error.path, folder.path);
        assert.equal(error.message, `${folder.path} has unsafe permissions`);
        return true;
      });
      assert.equal(await codeOf(lstat(endpoint.address.path)), 'ENOENT');
    });
  }

  test('is refused when it is a link to a safe folder of this user', async () => {
    // Arrange
    await using folder = defaultFolder();
    await using target = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    await chmod(target.path, 0o700);
    await symlink(target.path, folder.path);
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });

    // Act
    const listening = endpoint.listen(() => {});

    // Assert
    await assert.rejects(listening, (error: unknown) => {
      assert.ok(error instanceof UnsafeFolderError);
      assert.equal(error.path, folder.path);
      assert.equal(error.message, `${folder.path} is not a folder`);
      return true;
    });
    assert.equal(await codeOf(lstat(join(target.path, 'greeter'))), 'ENOENT');
  });

  test('is refused when it is a file', async () => {
    // Arrange
    await using folder = defaultFolder();
    await writeFile(folder.path, '', { mode: 0o600 });
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });

    // Act
    const listening = endpoint.listen(() => {});

    // Assert
    await assert.rejects(listening, (error: unknown) => {
      assert.ok(error instanceof UnsafeFolderError);
      assert.equal(error.message, `${folder.path} is not a folder`);
      return true;
    });
    assert.equal(await readFile(folder.path, 'utf8'), '');
  });

  test(
    'is refused when another user owns it',
    {
      skip:
        posixOnly ||
        (process.getuid?.() === 0
          ? false
          : 'only root can give a folder to another user'),
    },
    async () => {
      // Arrange
      await using folder = defaultFolder();
      await mkdir(folder.path, { mode: 0o700 });
      await chown(folder.path, 65_534, 65_534);
      const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });

      // Act
      const listening = endpoint.listen(() => {});

      // Assert
      await assert.rejects(listening, (error: unknown) => {
        assert.ok(error instanceof UnsafeFolderError);
        assert.equal(error.message, `${folder.path} has unsafe permissions`);
        return true;
      });
    },
  );
});

describe('a rooted name', { skip: posixOnly }, () => {
  test('is the socket path as it is given, and listen binds there', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const name = `${scratch.path}/./a.sock`;

    // Act
    const endpoint = new PipeEndpoint(name, { prefix: 'unused' });
    await using _server = await endpoint.listen((socket) =>
      socket.end('rooted'),
    );

    // Assert
    assert.equal(endpoint.address.path, name);
    assert.ok((await lstat(join(scratch.path, 'a.sock'))).isSocket());
    assert.equal(await read(endpoint.address), 'rooted');
  });

  test('in a missing folder fails with the error of Node.js and makes no folder', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const missing = join(scratch.path, 'missing');
    const endpoint = new PipeEndpoint(join(missing, 'a.sock'), {
      prefix: 'unused',
    });

    // Act
    const code = await codeOf(endpoint.listen(() => {}));

    // Assert
    assert.ok(code === 'ENOENT' || code === 'EACCES', `code ${String(code)}`);
    assert.equal(await codeOf(lstat(missing)), 'ENOENT');
  });

  test(
    'in a folder that this user cannot write fails with EACCES',
    { skip: notRoot },
    async () => {
      // Arrange
      await using scratch = await new TemporaryFiles().directory('pipes-', {
        parent: '/tmp',
      });
      const locked = join(scratch.path, 'locked');
      await mkdir(locked, { mode: 0o500 });
      const endpoint = new PipeEndpoint(join(locked, 'a.sock'), {
        prefix: 'unused',
      });

      try {
        // Act
        const code = await codeOf(endpoint.listen(() => {}));

        // Assert
        assert.equal(code, 'EACCES');
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  test('fails when a folder is at the socket path, and leaves the folder', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('pipes-', {
      parent: '/tmp',
    });
    const name = join(scratch.path, 'a.sock');
    await mkdir(name);
    await writeFile(join(name, 'kept'), 'kept');
    const endpoint = new PipeEndpoint(name, { prefix: 'unused' });

    // Act
    const listening = endpoint.listen(() => {});

    // Assert
    await assert.rejects(listening, { code: 'ERR_FS_EISDIR' });
    assert.equal(await readFile(join(name, 'kept'), 'utf8'), 'kept');
  });
});

describe('the server', { skip: posixOnly }, () => {
  test('close removes the file and keeps the open connections open until the caller ends them', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('echo', { prefix: folder.prefix });
    const server = await endpoint.listen((socket) => socket.pipe(socket));
    const client = await endpoint.address.connect();
    // The close waits for the open connection, so a failed assertion must not leave it open.
    try {
      // Act
      const closed = server.close();

      // Assert
      assert.equal(await noServerCode(endpoint.address.connect()), 'ENOENT');
      client.write('still open');
      const [echo] = await once(client, 'data');
      assert.equal(String(echo), 'still open');
      client.end();
      await closed;
    } finally {
      client.destroy();
    }
  });

  test('await using removes the file at the end of the block', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });

    // Act
    {
      await using _server = await endpoint.listen(() => {});
      assert.ok((await lstat(endpoint.address.path)).isSocket());
    }

    // Assert
    assert.equal(await codeOf(lstat(endpoint.address.path)), 'ENOENT');
  });

  test('a close while the first close waits for an open connection waits too, and both resolve when it ends', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('echo', { prefix: folder.prefix });
    const server = await endpoint.listen((socket) => socket.pipe(socket));
    const client = await endpoint.address.connect();
    const settled: string[] = [];

    // Act
    const first = server.close().then(() => settled.push('first'));
    const second = server.close().then(() => settled.push('second'));
    client.write('round trip');
    await once(client, 'data');
    const beforeEnd = [...settled];
    client.end();
    await Promise.all([first, second]);

    // Assert
    assert.deepEqual(beforeEnd, []);
    assert.deepEqual(settled, ['first', 'second']);
    assert.equal(await codeOf(lstat(endpoint.address.path)), 'ENOENT');
  });

  test('a close after the server closed resolves', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
    const server = await endpoint.listen(() => {});
    await server.close();

    // Act
    await server.close();

    // Assert
    assert.equal(await codeOf(lstat(endpoint.address.path)), 'ENOENT');
  });

  test('a close after await using closed the server resolves', async () => {
    // Arrange
    await using folder = defaultFolder();
    const endpoint = new PipeEndpoint('greeter', { prefix: folder.prefix });
    let disposed: PipeServer | undefined;
    {
      await using server = await endpoint.listen(() => {});
      disposed = server;
    }

    // Act
    await disposed.close();

    // Assert
    assert.equal(await codeOf(lstat(endpoint.address.path)), 'ENOENT');
  });

  test('unref lets its program exit while it listens', async (t) => {
    // Arrange
    await using folder = defaultFolder();
    await using program =
      startProgram(`import { PipeEndpoint } from ${JSON.stringify(packageIndex)};
const server = await new PipeEndpoint('greeter', { prefix: ${JSON.stringify(folder.prefix)} }).listen(() => {});
console.log(server.unref() === server ? 'unref gives the server' : 'unref gives another value');`);

    // Act
    await program.printed('unref gives the server', { signal: t.signal });
    const code = await program.exited({ signal: t.signal });

    // Assert
    assert.equal(code, 0);
  });
});
