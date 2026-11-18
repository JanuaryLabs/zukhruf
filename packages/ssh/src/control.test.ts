import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Duplex, Readable, finished } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles, isErrno } from '@zukhruf/fs';

import { ControlClient, ControlMaster } from './control.ts';
import { Client, ExitError, ExitMissingError, PrivateKey } from './index.ts';
import { dial } from './testing/dial.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

interface Shared extends AsyncDisposable {
  /** The client that the master serves. */
  readonly client: Client;
  readonly master: ControlMaster;
  /** A client of the master, in this process. */
  readonly control: ControlClient;
  /** The directory of the socket. */
  readonly directory: string;
}

/**
 * A client of the sshd, and a master that serves it on a socket in a new
 * directory under /tmp: macOS's temporary directory is too long for the
 * sun_path of a Unix socket. Disposal closes the master, the client and the
 * directory.
 */
async function share(sshd: Sshd): Promise<Shared> {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(
    await new TemporaryFiles().directory('control-', { parent: '/tmp' }),
  );
  const client = stack.use(await dial(sshd));
  const master = stack.use(
    await ControlMaster.listen(client, join(directory.path, 'ssh.sock')),
  );
  const owned = stack.move();
  return {
    client,
    master,
    control: new ControlClient(master.path),
    directory: directory.path,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

interface Listener extends AsyncDisposable {
  /** host:port on 127.0.0.1, or the socket path. */
  readonly address: string;
}

/**
 * A server on a free port of 127.0.0.1, or on a Unix socket path, that gives
 * each connection it accepts to `accepted`. A socket of a server with
 * `allowHalfOpen` stays open after the end of its input, so it can answer, and
 * closes only when the test ends it. Disposal destroys the connections that
 * are still open: one that a failed test leaves open would keep `close()`
 * waiting.
 */
async function listen(
  path: string | undefined,
  accepted: (socket: Socket) => void,
  options: { readonly allowHalfOpen?: boolean } = {},
): Promise<Listener> {
  const sockets = new Set<Socket>();
  const server = createServer(options, (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    accepted(socket);
  });
  if (path === undefined) server.listen(0, '127.0.0.1');
  else server.listen(path);
  await once(server, 'listening');
  return {
    address: path ?? `127.0.0.1:${portOf(server)}`,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
  };
}

/** A server that answers each connection with `reply(input)` after the client ends its input. */
function answering(reply: (input: string) => string) {
  return (socket: Socket): void => {
    void inputOf(socket).then((input) => socket.end(reply(input)));
  };
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}

/** The input of a stream to its end. text() would destroy the stream at the end, before an answer. */
async function inputOf(stream: Duplex): Promise<string> {
  let input = '';
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    input += String(chunk);
  }
  return input;
}

/** The bytes of a stream to its end. buffer() would destroy the stream at the end, with writes still queued. */
async function bytesOf(stream: Duplex): Promise<Buffer> {
  return Buffer.concat(
    await Array.fromAsync(
      stream.iterator({ destroyOnReturn: false }),
      (chunk: Buffer) => chunk,
    ),
  );
}

async function exchange(stream: Duplex, input: string): Promise<string> {
  stream.end(input);
  return text(stream);
}

/** The error that ended the connection of `client`. */
function lossOf(client: Client): Promise<unknown> {
  return client.wait().then(
    () => assert.fail('the connection ended with no error'),
    (error: unknown) => error,
  );
}

/**
 * A command that writes nothing, holds a connection to the Unix socket `path`
 * while it runs, and ends when sshd closes its stdin.
 */
function commandOn(path: string): string {
  // In single quotes for the shell, so the script quotes with ".
  const script = `require("node:net").connect(${JSON.stringify(path)}); process.stdin.once("end", () => process.exit(0)).resume();`;
  return `exec '${process.execPath}' -e '${script}'`;
}

interface ChildClient extends AsyncDisposable {
  readonly child: ChildProcess;
  /** The lines that the child printed. */
  readonly lines: AsyncIterator<string>;
}

/** Starts src/testing/control-client.ts. Disposal kills it if it still runs. */
function startClient(
  mode: 'dial' | 'session' | 'output',
  path: string,
  argument: string,
): ChildClient {
  const child = spawn(
    process.execPath,
    [
      new URL('testing/control-client.ts', import.meta.url).pathname,
      mode,
      path,
      argument,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  return {
    child,
    lines: createInterface({ input: child.stdout! })[Symbol.asyncIterator](),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}

test(
  'a client process that dies by SIGKILL closes its dialed channel: the remote TCP server sees the connection close',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const accepted = Promise.withResolvers<Socket>();
    await using remote = await listen(undefined, (socket) => {
      socket.resume();
      accepted.resolve(socket);
    });
    await using client = startClient(
      'dial',
      shared.master.path,
      remote.address,
    );
    assert.deepEqual(await client.lines.next(), {
      done: false,
      value: 'ready',
    });
    const dialed = await untilAborted(accepted.promise, t.signal);
    const closed = once(dialed, 'close', { signal: t.signal });

    // Act
    client.child.kill('SIGKILL');

    // Assert
    await closed;
  },
);

test(
  "a client process that dies by SIGKILL closes its session: the session's command, which reads stdin, ends",
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const running = Promise.withResolvers<Socket>();
    await using commands = await listen(
      join(shared.directory, 'command.sock'),
      (socket) => {
        socket.resume();
        running.resolve(socket);
      },
    );
    await using client = startClient(
      'session',
      shared.master.path,
      commandOn(commands.address),
    );
    assert.deepEqual(await client.lines.next(), {
      done: false,
      value: 'ready',
    });
    const command = await untilAborted(running.promise, t.signal);
    const ended = once(command, 'close', { signal: t.signal });

    // Act
    client.child.kill('SIGKILL');

    // Assert
    await ended;
  },
);

test(
  "when the master's connection is lost, a dialed stream of a client fails with an error whose cause is the error that ended the connection",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using remote = await listen(undefined, (socket) => socket.resume());
    const lost = lossOf(shared.client);
    const stream = await shared.control.dial('tcp', remote.address);
    const failed = new Promise<unknown>((resolve) =>
      finished(stream, (error) => resolve(error)),
    );

    // Act: the sshd process of the connection dies, and its socket closes.
    sshd.kill('SIGKILL');

    // Assert
    const error = await failed;
    const cause = await lost;
    assert.ok(Error.isError(error));
    assert.ok(Error.isError(cause));
    assert.equal(error.message, 'ssh: the connection was lost');
    assert.ok(Error.isError(error.cause));
    assert.equal(error.cause.message, cause.message);
  },
);

test(
  "when the master's connection is lost, wait of a client's session rejects with ExitMissingError whose cause is the error that ended the connection",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const lost = lossOf(shared.client);
    const session = shared.control.newSession();
    await session.start('exec cat > /dev/null');

    // Act: the sshd process of the connection dies, and its socket closes.
    sshd.kill('SIGKILL');

    // Assert
    const missing = await session.wait().then(
      () => assert.fail('the session exited'),
      (error: unknown) => error,
    );
    const cause = await lost;
    assert.ok(missing instanceof ExitMissingError);
    assert.ok(Error.isError(missing.cause));
    assert.ok(Error.isError(cause));
    assert.equal(missing.cause.message, cause.message);
  },
);

test(
  "disposal of the master removes the socket file and closes each channel that it serves, and the master's client stays open",
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const accepted = Promise.withResolvers<Socket>();
    await using remote = await listen(undefined, (socket) => {
      socket.resume();
      accepted.resolve(socket);
    });
    const stream = await shared.control.dial('tcp', remote.address);
    stream.on('error', () => undefined).resume();
    const dialed = await untilAborted(accepted.promise, t.signal);
    const closed = once(dialed, 'close', { signal: t.signal });

    // Act
    await shared.master[Symbol.asyncDispose]();

    // Assert
    await closed;
    await assert.rejects(access(shared.master.path), (error) =>
      isErrno(error, 'ENOENT'),
    );
    const output = await shared.client.newSession().output('printf open');
    assert.equal(output.toString(), 'open');
  },
);

test(
  'a client process holds no connection when it has no channel, so it exits after its output',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);

    // Act
    await using client = startClient(
      'output',
      shared.master.path,
      'printf hello',
    );

    // Assert
    const output = await client.lines.next();
    const [code] = await once(client.child, 'exit', { signal: t.signal });
    assert.deepEqual(output, { done: false, value: 'hello' });
    assert.equal(code, 0);
  },
);

test(
  'dial to a port where nothing listens rejects with the reason of the server, as Client#dial words it',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const closed = await listen(undefined, () => undefined);
    const address = closed.address;
    await closed[Symbol.asyncDispose]();

    const direct = await shared.client.dial('tcp', address).then(
      () => assert.fail('the server opened the channel'),
      (error: unknown) => error,
    );

    // Act
    const dialed = await shared.control.dial('tcp', address).then(
      () => assert.fail('the master opened the channel'),
      (error: unknown) => error,
    );

    // Assert
    assert.ok(Error.isError(direct));
    assert.ok(Error.isError(dialed));
    assert.match(direct.message, /^ssh: the server refused the channel: \S/);
    assert.equal(dialed.message, direct.message);
  },
);

test('with no master at the path, dial and a session reject with the code ENOENT', async () => {
  // Arrange
  await using directory = await new TemporaryFiles().directory('control-', {
    parent: '/tmp',
  });
  const control = new ControlClient(join(directory.path, 'ssh.sock'));

  // Act
  const dialed = control.dial('tcp', '127.0.0.1:22');
  const ran = control.newSession().run('true');

  // Assert
  await assert.rejects(dialed, (error) => isErrno(error, 'ENOENT'));
  await assert.rejects(ran, (error) => isErrno(error, 'ENOENT'));
});

test(
  'a pty that the server refuses rejects shell with the reason of the server',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['PermitTTY no'] });
    await using shared = await share(sshd);
    await using direct = shared.client.newSession();
    direct.requestPty('xterm', { rows: 24, columns: 80 });
    const refusal = await direct.shell().then(
      () => assert.fail('the server accepted the pty'),
      (error: unknown) => error,
    );
    await using session = shared.control.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });

    // Act
    const shell = await session.shell().then(
      () => assert.fail('the master accepted the pty'),
      (error: unknown) => error,
    );

    // Assert
    assert.ok(Error.isError(refusal));
    assert.ok(Error.isError(shell));
    assert.match(refusal.message, /pseudo-terminal/);
    assert.equal(shell.message, refusal.message);
  },
);

test(
  'output gives the stdout of the command and not its stderr',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);

    // Act
    const output = await shared.control
      .newSession()
      .output('printf out; printf err >&2');

    // Assert
    assert.equal(output.toString(), 'out');
  },
);

test(
  'combinedOutput gives stdout and stderr in the order they came',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);

    // Act
    const output = await shared.control
      .newSession()
      .combinedOutput('printf 1; sleep 0.2; printf 2 >&2; sleep 0.2; printf 3');

    // Assert
    assert.equal(output.toString(), '123');
  },
);

test(
  'start streams stdin to the command, its end is the end of input, and stdout gives what the command wrote',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using session = shared.control.newSession();
    session.stdin.write('before the start\n');

    // Act
    await session.start('tr a-z A-Z');
    session.stdin.end('after the start\n');
    const read = text(session.stdout);

    // Assert
    assert.equal(await read, 'BEFORE THE START\nAFTER THE START\n');
    await session.wait();
  },
);

test(
  'a session whose command exits without reading all of its stdin leaves the master serving: wait() resolves, stdout gives what the command wrote, and a new session runs',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using session = shared.control.newSession();
    const read = text(session.stdout);
    // After head, the shell holds stdin open and unread for a second, so the
    // master's write to the channel waits for window when the command exits.
    await session.start('head -c1; sleep 1');
    const chunk = Buffer.alloc(64 * 1024, 'a');
    const written = pipeline(
      Readable.from(Array.from({ length: 1600 }, () => chunk)),
      session.stdin,
    );

    // Act
    await session.wait();

    // Assert
    assert.equal(await read, 'a');
    const output = await shared.control.newSession().output('printf ok');
    assert.equal(output.toString(), 'ok');
    await written;
  },
);

test(
  'run of a command that exits with status 3 rejects with ExitError, whose exit holds the status, and with status 0 resolves',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);

    // Act
    const failed = shared.control.newSession().run('exit 3');
    const succeeded = shared.control.newSession().run('exit 0');

    // Assert
    await assert.rejects(failed, (error) => {
      assert.ok(error instanceof ExitError);
      assert.deepEqual(error.exit, { kind: 'status', exitStatus: 3 });
      return true;
    });
    await succeeded;
  },
);

test(
  'run of a command that a signal ended rejects with ExitError, whose exit holds the signal',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);

    // Act
    const ran = shared.control.newSession().run('kill -KILL $$');

    // Assert
    await assert.rejects(ran, (error) => {
      assert.ok(error instanceof ExitError);
      assert.deepEqual(error.exit, {
        kind: 'signal',
        signal: 'KILL',
        coreDumped: false,
        errorMessage: '',
      });
      return true;
    });
  },
);

test(
  'the variables of setenv reach the command',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd({ config: ['AcceptEnv ZUKHRUF_*'] });
    await using shared = await share(sshd);
    const session = shared.control.newSession();
    session.setenv('ZUKHRUF_SHARED', 'through the master');

    // Act
    const output = await session.output('printf "%s" "$ZUKHRUF_SHARED"');

    // Assert
    assert.equal(output.toString(), 'through the master');
  },
);

test(
  'requestPty, then shell, runs a login shell on a terminal, and windowChange gives it its new size',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using session = shared.control.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });
    await session.shell();

    // Act
    await session.windowChange({ rows: 33, columns: 101 });
    // Markers: the shell of a CI runner printed tty's line and stty's with
    // no line end between them, so the test reads each value by its marker.
    session.stdin.write(
      'printf "tty:%s:\\n" "$(tty)"; printf "size:%s:\\n" "$(stty size)"; exit\n',
    );
    const output = await text(session.stdout);

    // Assert
    assert.match(output, /tty:\/dev\/(pts\/|ttys)\d+:/);
    assert.match(output, /size:33 101:/);
    await session.wait();
  },
);

test(
  'signal delivers the signal to the command',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using session = shared.control.newSession();
    // start() resolves when the server accepts the command, before sshd has
    // started it: a signal sent at once can find no process group to kill.
    await session.start('echo started; exec sleep 30');
    await once(session.stdout, 'data');

    // Act
    await session.signal('TERM');

    // Assert
    await assert.rejects(session.wait(), (error) => {
      assert.ok(error instanceof ExitError);
      assert.equal(error.exit.kind === 'signal' && error.exit.signal, 'TERM');
      return true;
    });
  },
);

test(
  "dial('tcp') reaches a TCP server on the remote host, and the data goes both ways",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using remote = await listen(
      undefined,
      answering((input) => `got ${input}`),
      { allowHalfOpen: true },
    );

    // Act
    const stream = await shared.control.dial('tcp', remote.address);

    // Assert
    assert.equal(await exchange(stream, 'ping'), 'got ping');
  },
);

test(
  "dial('unix') reaches a Unix socket on the remote host, and the data goes both ways",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using remote = await listen(
      join(shared.directory, 'remote.sock'),
      answering((input) => `got ${input}`),
      { allowHalfOpen: true },
    );

    // Act
    const stream = await shared.control.dial('unix', remote.address);

    // Assert
    assert.equal(await exchange(stream, 'ping'), 'got ping');
  },
);

test(
  'the end of the write side of a dialed stream ends the input of the remote socket, and the remote side can still answer',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const remoteEnded = Promise.withResolvers<Socket>();
    await using remote = await listen(
      undefined,
      (socket) => {
        socket.resume();
        socket.once('end', () => remoteEnded.resolve(socket));
      },
      { allowHalfOpen: true },
    );
    const stream = await shared.control.dial('tcp', remote.address);

    // Act
    stream.end();

    // Assert
    const accepted = await remoteEnded.promise;
    accepted.end('after your end');
    assert.equal(await text(stream), 'after your end');
  },
);

test(
  'the end of the remote socket ends the read side of a dialed stream, and the stream can still write to it',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const received = Promise.withResolvers<string>();
    await using remote = await listen(
      undefined,
      (socket) => {
        socket.end('remote ended');
        void inputOf(socket).then(received.resolve);
      },
      { allowHalfOpen: true },
    );
    const stream = await shared.control.dial('tcp', remote.address);

    // Act
    const read = await inputOf(stream);
    stream.end('after the remote end');

    // Assert
    assert.equal(read, 'remote ended');
    assert.equal(await received.promise, 'after the remote end');
  },
);

test(
  'destroy of a dialed stream closes the remote socket',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const accepted = Promise.withResolvers<Socket>();
    await using remote = await listen(undefined, (socket) => {
      socket.resume();
      accepted.resolve(socket);
    });
    const stream = await shared.control.dial('tcp', remote.address);
    const dialed = await untilAborted(accepted.promise, t.signal);
    const closed = once(dialed, 'close', { signal: t.signal });

    // Act
    stream.destroy();

    // Assert
    await closed;
  },
);

test(
  'two clients of one master each get the bytes of their own channel, and the close of a third channel leaves them open',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    await using remote = await listen(
      undefined,
      answering((input) => `got ${input}`),
      { allowHalfOpen: true },
    );
    const other = new ControlClient(shared.master.path);
    const first = await shared.control.dial('tcp', remote.address);
    const second = await other.dial('tcp', remote.address);
    const third = await other.dial('tcp', remote.address);

    // Act
    third.destroy();
    const answers = await Promise.all([
      exchange(first, 'one'),
      exchange(second, 'two'),
    ]);

    // Assert
    assert.deepEqual(answers, ['got one', 'got two']);
  },
);

test(
  "disposal of the master ends a session that it serves: the session's command, which reads stdin, ends, wait rejects with ExitMissingError, and a new client finds no master",
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const running = Promise.withResolvers<Socket>();
    await using commands = await listen(
      join(shared.directory, 'command.sock'),
      (socket) => {
        socket.resume();
        running.resolve(socket);
      },
    );
    const session = shared.control.newSession();
    await session.start(commandOn(commands.address));
    const command = await untilAborted(running.promise, t.signal);
    const ended = once(command, 'close', { signal: t.signal });

    // Act
    await shared.master[Symbol.asyncDispose]();

    // Assert
    await ended;
    await assert.rejects(session.wait(), ExitMissingError);
    await assert.rejects(
      new ControlClient(shared.master.path).dial('tcp', '127.0.0.1:22'),
      (error) => isErrno(error, 'ENOENT'),
    );
  },
);

test(
  'a dialed stream carries more data than every buffer holds, both ways and whole, to a reader that starts late',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using shared = await share(sshd);
    const upload = randomBytes(8 * 1024 * 1024);
    // Less than the SSH window of 2 MiB, so the remote writes it all while
    // the client reads nothing.
    const download = randomBytes(1024 * 1024);
    const received = Promise.withResolvers<Buffer>();
    await using remote = await listen(
      undefined,
      (socket) => {
        socket.end(download);
        void bytesOf(socket).then(received.resolve);
      },
      { allowHalfOpen: true },
    );
    const stream = await shared.control.dial('tcp', remote.address);

    // Act: the download comes in while the upload goes out, and the client
    // reads it only after the remote has the whole upload.
    for (let offset = 0; offset < upload.length; offset += 65_536) {
      stream.write(upload.subarray(offset, offset + 65_536));
    }
    stream.end();
    const uploaded = await untilAborted(received.promise, t.signal);
    const downloaded = await bytesOf(stream);

    // Assert
    assert.ok(uploaded.equals(upload));
    assert.ok(downloaded.equals(download));
  },
);
