import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { Latch } from '@zukhruf/async';

import {
  AuthenticationError,
  Client,
  ExitError,
  PrivateKey,
  ServerConn,
  type ServerSession,
  type SessionRequest,
  type Signer,
} from './index.ts';
import { startSshClientRig } from './testing/ssh-client.ts';

const run = promisify(execFile);

const noSsh =
  process.platform === 'win32'
    ? 'the tests run the OpenSSH client against unix sockets in /tmp'
    : false;

async function generateKey(
  directory: string,
  name: string,
): Promise<PrivateKey> {
  const file = join(directory, name);
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
  return PrivateKey.parse(await readFile(file));
}

/** Gives each session channel to `serve`, rejects every other channel, and ends when the connection ends. */
async function eachSession(
  conn: ServerConn,
  serve: (session: ServerSession) => Promise<void>,
): Promise<void> {
  const served: Promise<void>[] = [];
  for await (const channel of conn.channels()) {
    if (channel.type === 'session') served.push(serve(channel.accept()));
    else channel.reject();
  }
  await Promise.all(served);
}

/** Refuses each request that wants an answer, until exec or shell; accepts that one after `answer` chose, and exits with what `run` returns. */
async function command(
  session: ServerSession,
  run: (request: SessionRequest) => Promise<number>,
): Promise<void> {
  for await (const request of session.requests()) {
    if (request.type === 'exec' || request.type === 'shell') {
      request.accept();
      await session.exit(await run(request));
      return;
    }
    if ('reject' in request) request.reject();
  }
}

/** A TCP server on 127.0.0.1 that answers each connection with what it read, in upper case. */
async function upperCaseServer(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    void readToEnd(socket).then((data) => socket.end(data.toUpperCase()));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('no TCP port');
  }
  return {
    port: address.port,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

/** The data of `stream` up to its end. Unlike text() of node:stream/consumers, it keeps the stream open for writing. */
async function readToEnd(stream: Readable): Promise<string> {
  const chunks = await Array.fromAsync(
    stream.iterator({ destroyOnReturn: false }),
    (chunk: Buffer) => Buffer.from(chunk),
  );
  return Buffer.concat(chunks).toString();
}

async function exchange(socket: Socket, data: string): Promise<string> {
  socket.end(data);
  return text(socket);
}

test(
  'a signature that the private key of the offered public key did not make is refused, though the publicKey callback accepts the key',
  { skip: noSsh },
  async () => {
    // Arrange
    const outcome: { server?: string } = {};
    await using rig = await startSshClientRig(async (socket) => {
      outcome.server = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      }).then(
        async (conn) => {
          await conn.close();
          return 'logged in';
        },
        () => 'refused',
      );
    });
    const other = await generateKey(rig.directory, 'other_ed25519');
    const forged: Signer = {
      publicKey: rig.userKey,
      sign: (data, algorithm) => other.sign(data, algorithm),
    };

    // Act
    const dial = Client.dial(`127.0.0.1:${rig.port}`, {
      user: 'test',
      auth: [{ type: 'publickey', signers: async () => [forged] }],
      hostKey: () => {},
      clock: createClock(),
    });

    // Assert
    await assert.rejects(dial, AuthenticationError);
    await rig.handled();
    assert.equal(outcome.server, 'refused');
  },
);

test(
  'ssh offering a key that the publicKey callback refuses is denied, and the handshake rejects',
  { skip: noSsh },
  async () => {
    // Arrange
    const outcome: { server?: string } = {};
    await using rig = await startSshClientRig(async (socket) => {
      outcome.server = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: () => false,
      }).then(
        async (conn) => {
          await conn.close();
          return 'logged in';
        },
        () => 'refused',
      );
    });

    // Act
    const ssh = await rig.ssh(['-o', 'BatchMode=yes'], ['true']);

    // Assert
    assert.equal(ssh.code, 255);
    assert.match(ssh.stderr, /Permission denied \(publickey\)/);
    await rig.handled();
    assert.equal(outcome.server, 'refused');
  },
);

test(
  'a publicKey callback that throws rejects the handshake with its error, and ssh is not logged in',
  { skip: noSsh },
  async () => {
    // Arrange
    const failure = new Error('the key store is down');
    const outcome: { error?: unknown } = {};
    await using rig = await startSshClientRig(async (socket) => {
      await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: () => {
          throw failure;
        },
      }).catch((error: unknown) => {
        outcome.error = error;
      });
    });

    // Act
    const ssh = await rig.ssh(['-o', 'BatchMode=yes'], ['true']);

    // Assert
    assert.equal(ssh.code, 255);
    await rig.handled();
    assert.equal(outcome.error, failure);
  },
);

test(
  'an abort during the handshake rejects it with the reason and closes the transport',
  { skip: noSsh },
  async () => {
    // Arrange
    const controller = new AbortController();
    const reason = new Error('too slow');
    const outcome: { error?: unknown } = {};
    await using rig = await startSshClientRig(async (socket) => {
      const handshake = ServerConn.handshake(
        socket,
        { hostKeys: [rig.hostKey], publicKey: () => true },
        { signal: controller.signal },
      );
      controller.abort(reason);
      await handshake.catch((error: unknown) => {
        outcome.error = error;
      });
    });
    const client = connect(rig.port, '127.0.0.1');

    // Act
    const received = await text(client);

    // Assert
    assert.match(received, /^SSH-2\.0-|^$/);
    await rig.handled();
    assert.equal(outcome.error, reason);
  },
);

test(
  'ssh logs in with the allowed key, runs the command that the server accepts after a client EOF, and exits with the status of exit(); channels() ends when ssh leaves',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: { user?: string; command?: string } = {};
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (user, key) => user === 'test' && key.equals(rig.userKey),
      });
      seen.user = conn.user;
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'exec') {
            seen.command = request.command;
            await nextMacrotask();
            request.accept();
            await session.exit(7);
            return;
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh([], ['echo', 'hi'], { input: '' });

    // Assert
    assert.equal(ssh.code, 7, ssh.stderr);
    await rig.handled();
    assert.equal(seen.user, 'test');
    assert.equal(seen.command, 'echo hi');
  },
);

test(
  'stdin that ssh sends before the server accepts the command reaches session.stdin intact, and stdout and stderr reach ssh before the exit',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'exec') {
            await nextMacrotask();
            request.accept();
            const input = await text(session.stdin);
            session.stdout.write(`out:${input}`);
            session.stderr.write('err:done');
            await session.exit(0);
            return;
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh([], ['cat'], { input: 'hello' });

    // Assert
    assert.equal(ssh.code, 0, ssh.stderr);
    assert.equal(ssh.stdout, 'out:hello');
    assert.match(ssh.stderr, /err:done/);
  },
);

test(
  'a command that the server rejects after a delay reaches ssh as a failed exec request',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'exec') {
            await nextMacrotask();
            request.reject();
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh([], ['true'], { input: '' });

    // Assert
    assert.equal(ssh.code, 255);
    assert.match(ssh.stderr, /exec request failed on channel 0/);
  },
);

test(
  'password: ssh logs in with the password that the callback accepts, and is denied with another',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      const conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        password: (user, password) => user === 'test' && password === 'open',
      }).catch((error: unknown) => {
        // A client that fails to log in closes the connection.
        if (
          Error.isError(error) &&
          error.message === 'ssh: the client closed the connection'
        ) {
          return undefined;
        }
        throw error;
      });
      if (conn === undefined) return;
      await using _conn = conn;
      await eachSession(conn, (session) => command(session, async () => 0));
    });
    const askpass = async (password: string): Promise<string> => {
      const file = join(rig.directory, `askpass-${password}`);
      await writeFile(file, `#!/bin/sh\necho ${password}\n`, { mode: 0o755 });
      return file;
    };
    const login = async (password: string) =>
      rig.ssh(
        [
          '-o',
          'PreferredAuthentications=password',
          '-o',
          'NumberOfPasswordPrompts=1',
        ],
        ['true'],
        {
          env: {
            SSH_ASKPASS: await askpass(password),
            SSH_ASKPASS_REQUIRE: 'force',
          },
        },
      );

    // Act
    const right = await login('open');
    const wrong = await login('closed');

    // Assert
    assert.equal(right.code, 0, right.stderr);
    assert.equal(wrong.code, 255);
    assert.match(wrong.stderr, /Permission denied/);
  },
);

test(
  'keyboard-interactive: the prompt of ask() reaches ssh, and its answer reaches the callback, which logs in',
  { skip: noSsh },
  async () => {
    // Arrange
    const answers: (readonly string[])[] = [];
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        keyboardInteractive: async (_user, ask) => {
          const answer = await ask([{ prompt: 'Code: ', echo: false }]);
          answers.push(answer);
          return answer[0] === '424242';
        },
      });
      await eachSession(conn, (session) => command(session, async () => 0));
    });
    const asked = join(rig.directory, 'asked');
    const askpass = join(rig.directory, 'askpass');
    await writeFile(
      askpass,
      `#!/bin/sh\nprintf '%s' "$1" > ${asked}\necho 424242\n`,
      {
        mode: 0o755,
      },
    );

    // Act
    const ssh = await rig.ssh(
      ['-o', 'PreferredAuthentications=keyboard-interactive'],
      ['true'],
      { env: { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' } },
    );

    // Assert
    assert.equal(ssh.code, 0, ssh.stderr);
    assert.match(await readFile(asked, 'utf8'), /Code: $/);
    assert.deepEqual(answers, [['424242']]);
  },
);

test(
  'exit with a signal reaches the client as exit-signal',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'exec') {
            request.accept();
            await session.exit({ signal: 'TERM', errorMessage: 'stopped' });
            return;
          }
        }
      });
    });
    const key = PrivateKey.parse(
      await readFile(join(rig.directory, 'id_ed25519')),
    );
    await using client = await Client.dial(`127.0.0.1:${rig.port}`, {
      user: 'test',
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => {},
      clock: createClock(),
    });

    // Act
    const ran = client.newSession().run('sleep 60');

    // Assert
    await assert.rejects(
      ran,
      (error) =>
        error instanceof ExitError &&
        error.exit.kind === 'signal' &&
        error.exit.signal === 'TERM' &&
        error.exit.errorMessage === 'stopped',
    );
  },
);

test(
  'the env and the pty-req of ssh -tt reach session.requests(), and the accepted pty reaches ssh',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: SessionRequest[] = [];
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          seen.push(request);
          if (request.type === 'pty-req' || request.type === 'env') {
            request.accept();
          } else if (request.type === 'exec') {
            request.accept();
            await session.exit(0);
            return;
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh(
      ['-tt', '-o', 'SetEnv=GREETING=hello'],
      ['true'],
      { env: { TERM: 'xterm-test' } },
    );

    // Assert
    assert.equal(ssh.code, 0, ssh.stderr);
    assert.doesNotMatch(ssh.stderr, /PTY allocation request failed/);
    const env = seen.find((request) => request.type === 'env');
    const pty = seen.find((request) => request.type === 'pty-req');
    assert.deepEqual(env && { name: env.name, value: env.value }, {
      name: 'GREETING',
      value: 'hello',
    });
    assert.equal(pty?.term, 'xterm-test');
  },
);

test(
  'ssh -tt with no command asks for a shell, and the accepted shell reaches ssh',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'pty-req') request.accept();
          if (request.type === 'shell') {
            request.accept();
            session.stdout.write('shell here\n');
            await session.exit(3);
            return;
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh(['-tt'], []);

    // Assert
    assert.equal(ssh.code, 3, ssh.stderr);
    assert.match(ssh.stdout, /shell here/);
  },
);

test(
  'ssh -A asks for agent forwarding with auth-agent-req@openssh.com',
  { skip: noSsh },
  async () => {
    // Arrange
    const types: string[] = [];
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          types.push(request.type);
          if (request.type === 'exec') {
            request.accept();
            await session.exit(0);
            return;
          }
          if ('reject' in request) request.reject();
        }
      });
    });
    const agent = join(rig.directory, 'agent.sock');
    const agentServer = createServer((socket) => socket.destroy());
    const listening = Promise.withResolvers<void>();
    agentServer.listen(agent, listening.resolve);
    await listening.promise;

    try {
      // Act
      const ssh = await rig.ssh(
        ['-A', '-o', `IdentityAgent=${agent}`],
        ['true'],
      );

      // Assert
      assert.equal(ssh.code, 0, ssh.stderr);
      assert.ok(types.includes('auth-agent-req@openssh.com'), types.join());
    } finally {
      agentServer.close();
    }
  },
);

test(
  'ssh -W host:port opens direct-tcpip with that address, and the accepted stream carries data both ways',
  { skip: noSsh },
  async () => {
    // Arrange
    const target = await upperCaseServer();
    const seen: { address?: string } = {};
    try {
      await using rig = await startSshClientRig(async (socket) => {
        await using conn = await ServerConn.handshake(socket, {
          hostKeys: [rig.hostKey],
          publicKey: (_user, key) => key.equals(rig.userKey),
        });
        for await (const channel of conn.channels()) {
          if (channel.type !== 'direct-tcpip') {
            channel.reject();
            continue;
          }
          seen.address = channel.address;
          const stream = channel.accept();
          const upstream = connect(target.port, '127.0.0.1');
          stream.pipe(upstream).pipe(stream);
        }
      });

      // Act
      const ssh = await rig.ssh(['-W', `127.0.0.1:${target.port}`], [], {
        input: 'ping',
      });

      // Assert
      assert.equal(ssh.code, 0, ssh.stderr);
      assert.equal(ssh.stdout, 'PING');
      assert.equal(seen.address, `127.0.0.1:${target.port}`);
    } finally {
      await target.close();
    }
  },
);

test(
  'a rejected channel reaches ssh as a failed open: a session, a direct-tcpip and a direct-streamlocal channel',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      for await (const channel of conn.channels()) channel.reject();
    });

    // Act
    const session = await rig.ssh([], ['true']);
    const tcp = await rig.ssh(['-W', '127.0.0.1:1'], []);
    const unix = await rig.ssh(['-W', join(rig.directory, 'none.sock')], []);

    // Assert
    for (const ssh of [session, tcp, unix]) {
      assert.equal(ssh.code, 255);
      assert.match(ssh.stderr, /open failed/);
    }
  },
);

test(
  'ssh -L to a unix socket opens direct-streamlocal@openssh.com with the remote path, and the accepted stream carries data',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: { path?: string; reply?: string } = {};
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      for await (const channel of conn.channels()) {
        if (channel.type === 'direct-streamlocal@openssh.com') {
          seen.path = channel.path;
          const stream = channel.accept();
          void readToEnd(stream).then((data) => stream.end(data.toUpperCase()));
        } else if (channel.type === 'session') {
          const session = channel.accept();
          void command(session, async () => {
            seen.reply = await exchange(connect(local), 'ping');
            return 0;
          });
        } else {
          channel.reject();
        }
      }
    });
    const local = join(rig.directory, 'local.sock');
    const remote = join(rig.directory, 'remote.sock');

    // Act
    const ssh = await rig.ssh(['-L', `${local}:${remote}`], ['true']);

    // Assert
    assert.equal(ssh.code, 0, ssh.stderr);
    assert.equal(seen.path, remote);
    assert.equal(seen.reply, 'PING');
  },
);

test(
  'ssh -R asks tcpip-forward, accept(port) reaches ssh, and a stream of forward("tcp") reaches the target of ssh',
  { skip: noSsh },
  async () => {
    // Arrange
    const target = await upperCaseServer();
    const seen: { address?: string; reply?: string } = {};
    try {
      await using rig = await startSshClientRig(async (socket) => {
        await using conn = await ServerConn.handshake(socket, {
          hostKeys: [rig.hostKey],
          publicKey: (_user, key) => key.equals(rig.userKey),
        });
        const forwarded = new Latch<string>();
        void (async () => {
          for await (const request of conn.requests()) {
            if (request.type === 'tcpip-forward') {
              seen.address = request.address;
              request.accept(4242);
              forwarded.open(request.address.replace(/:0$/, ':4242'));
            } else {
              request.reject();
            }
          }
        })();
        await eachSession(conn, (session) =>
          command(session, async () => {
            const stream = await conn.forward(
              'tcp',
              await forwarded.wait(),
              '127.0.0.1:50000',
            );
            seen.reply = await text(stream.end('ping'));
            return 0;
          }),
        );
      });

      // Act
      const ssh = await rig.ssh(
        ['-o', 'ExitOnForwardFailure=yes', '-R', `0:127.0.0.1:${target.port}`],
        ['true'],
      );

      // Assert
      assert.equal(ssh.code, 0, ssh.stderr);
      assert.match(seen.address ?? '', /:0$/);
      assert.match(ssh.stderr, /Allocated port 4242 for remote forward/);
      assert.equal(seen.reply, 'PING');
    } finally {
      await target.close();
    }
  },
);

test(
  'a rejected tcpip-forward reaches ssh as a failed remote forward',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      void (async () => {
        for await (const request of conn.requests()) request.reject();
      })();
      await eachSession(conn, (session) => command(session, async () => 0));
    });

    // Act
    const ssh = await rig.ssh(
      ['-o', 'ExitOnForwardFailure=yes', '-R', '0:127.0.0.1:1'],
      ['true'],
    );

    // Assert
    assert.equal(ssh.code, 255);
    assert.match(ssh.stderr, /remote port forwarding failed/);
  },
);

test(
  'ssh -R with unix sockets asks streamlocal-forward@openssh.com, and a stream of forward("unix") reaches the local socket of ssh',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: { path?: string; reply?: string } = {};
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      const forwarded = new Latch<string>();
      void (async () => {
        for await (const request of conn.requests()) {
          if (request.type === 'streamlocal-forward@openssh.com') {
            seen.path = request.path;
            request.accept();
            forwarded.open(request.path);
          } else {
            request.reject();
          }
        }
      })();
      await eachSession(conn, (session) =>
        command(session, async () => {
          const stream = await conn.forward('unix', await forwarded.wait());
          seen.reply = await text(stream.end('ping'));
          return 0;
        }),
      );
    });
    const local = join(rig.directory, 'local.sock');
    const remote = join(rig.directory, 'remote.sock');
    const localServer = createServer({ allowHalfOpen: true }, (socket) => {
      void readToEnd(socket).then((data) => socket.end(data.toUpperCase()));
    });
    const listening = Promise.withResolvers<void>();
    localServer.listen(local, listening.resolve);
    await listening.promise;

    try {
      // Act
      const ssh = await rig.ssh(
        ['-o', 'ExitOnForwardFailure=yes', '-R', `${remote}:${local}`],
        ['true'],
      );

      // Assert
      assert.equal(ssh.code, 0, ssh.stderr);
      assert.equal(seen.path, remote);
      assert.equal(seen.reply, 'PING');
    } finally {
      localServer.close();
    }
  },
);

test(
  'ssh -O cancel through a control master sends cancel-tcpip-forward and cancel-streamlocal-forward@openssh.com with their addresses',
  { skip: noSsh },
  async () => {
    // Arrange
    const cancels: string[] = [];
    const started = new Latch();
    const cancelled = new Latch();
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      void (async () => {
        for await (const request of conn.requests()) {
          request.accept();
          if (request.type === 'cancel-tcpip-forward') {
            cancels.push(request.address);
          } else if (
            request.type === 'cancel-streamlocal-forward@openssh.com'
          ) {
            cancels.push(request.path);
          }
          if (cancels.length === 2) cancelled.open();
        }
      })();
      await eachSession(conn, (session) =>
        command(session, async () => {
          started.open();
          await cancelled.wait();
          return 0;
        }),
      );
    });
    const control = join(rig.directory, 'control');
    const remote = join(rig.directory, 'remote.sock');
    const forwards = [
      '-R',
      '4711:127.0.0.1:1',
      '-R',
      `${remote}:/nowhere.sock`,
    ];

    // Act
    const master = rig.ssh(
      ['-o', 'ControlMaster=yes', '-o', `ControlPath=${control}`, ...forwards],
      ['true'],
    );
    await started.wait();
    const cancel = await rig.ssh(
      ['-o', `ControlPath=${control}`, '-O', 'cancel', ...forwards],
      [],
    );
    const ended = await master;

    // Assert
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.equal(ended.code, 0, ended.stderr);
    assert.deepEqual(cancels.toSorted(), [remote, 'localhost:4711'].toSorted());
  },
);

test(
  'signal and window-change of a session of the package reach session.requests()',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: SessionRequest[] = [];
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'exec') request.accept();
          else if ('accept' in request) request.accept();
          else seen.push(request);
          if (seen.length === 2) {
            await session.exit(0);
            return;
          }
        }
      });
    });
    const key = PrivateKey.parse(
      await readFile(join(rig.directory, 'id_ed25519')),
    );
    await using client = await Client.dial(`127.0.0.1:${rig.port}`, {
      user: 'test',
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => {},
      clock: createClock(),
    });
    const session = client.newSession();
    session.requestPty('xterm', { rows: 24, columns: 80 });
    await session.start('sleep 60');

    // Act
    await session.windowChange({ rows: 40, columns: 120, width: 0, height: 0 });
    await session.signal('USR1');

    // Assert
    await session.wait();
    assert.deepEqual(seen, [
      {
        type: 'window-change',
        size: { rows: 40, columns: 120, width: 0, height: 0 },
      },
      { type: 'signal', name: 'USR1' },
    ]);
  },
);

test(
  'close() ends the connection: ssh in the middle of a command exits 255',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      const conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      for await (const channel of conn.channels()) {
        if (channel.type !== 'session') continue;
        const session = channel.accept();
        for await (const request of session.requests()) {
          if (request.type === 'exec') {
            request.accept();
            await conn.close();
          }
        }
      }
    });

    // Act
    const ssh = await rig.ssh([], ['sleep', '60']);

    // Assert
    assert.equal(ssh.code, 255);
  },
);

test(
  'an accepted pty-req of a session of the package gets its reply, so the command starts',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: { term?: string } = {};
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'pty-req') {
            seen.term = request.term;
            await nextMacrotask();
            request.accept();
          } else if (request.type === 'exec') {
            request.accept();
            await session.exit(0);
            return;
          }
        }
      });
    });
    const key = PrivateKey.parse(
      await readFile(join(rig.directory, 'id_ed25519')),
    );
    await using client = await Client.dial(`127.0.0.1:${rig.port}`, {
      user: 'test',
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => {},
      clock: createClock(),
    });
    const session = client.newSession();
    session.requestPty('vt100', { rows: 24, columns: 80 });

    // Act
    await session.run('true');

    // Assert
    assert.equal(seen.term, 'vt100');
  },
);

test(
  'exit with a vendor signal name reaches the client as exit-signal with that name',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'exec') {
            request.accept();
            await session.exit({
              signal: 'XCPU@openssh.com',
              coreDumped: true,
            });
            return;
          }
        }
      });
    });
    const key = PrivateKey.parse(
      await readFile(join(rig.directory, 'id_ed25519')),
    );
    await using client = await Client.dial(`127.0.0.1:${rig.port}`, {
      user: 'test',
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => {},
      clock: createClock(),
    });

    // Act
    const ran = client.newSession().run('true');

    // Assert
    await assert.rejects(
      ran,
      (error) =>
        error instanceof ExitError &&
        error.exit.kind === 'signal' &&
        error.exit.signal === 'XCPU@openssh.com' &&
        error.exit.coreDumped,
    );
  },
);

test(
  'the pty-req of ssh on a real terminal reaches the session with its modes, IUTF8 (RFC 8160) among them',
  { skip: noSsh },
  async () => {
    // Arrange
    const seen: { term?: string; modes?: Readonly<Record<string, number>> } =
      {};
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        for await (const request of session.requests()) {
          if (request.type === 'pty-req') {
            seen.term = request.term;
            seen.modes = request.modes;
            request.accept();
          } else if (request.type === 'exec') {
            request.accept();
            await session.exit(0);
            return;
          } else if ('reject' in request) {
            request.reject();
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh(['-tt'], ['true'], {
      terminal: true,
      env: { TERM: 'xterm-test' },
    });

    // Assert
    assert.equal(ssh.code, 0, `${ssh.stdout}${ssh.stderr}`);
    assert.equal(seen.term, 'xterm-test');
    assert.ok(seen.modes !== undefined && 'IUTF8' in seen.modes, ssh.stdout);
    assert.ok('VINTR' in (seen.modes ?? {}));
  },
);

test(
  'replies to deferred session requests keep the order of the requests: a pty-req refused after its exec was accepted reaches ssh as a refused pty',
  { skip: noSsh },
  async () => {
    // Arrange
    await using rig = await startSshClientRig(async (socket) => {
      await using conn = await ServerConn.handshake(socket, {
        hostKeys: [rig.hostKey],
        publicKey: (_user, key) => key.equals(rig.userKey),
      });
      await eachSession(conn, async (session) => {
        const held: { pty?: { reject(): void } } = {};
        for await (const request of session.requests()) {
          if (request.type === 'pty-req') {
            held.pty = request;
          } else if (request.type === 'exec') {
            request.accept();
            held.pty?.reject();
            await session.exit(0);
            return;
          }
        }
      });
    });

    // Act
    const ssh = await rig.ssh(['-tt'], ['true']);

    // Assert
    assert.match(ssh.stderr, /PTY allocation request failed/);
    assert.doesNotMatch(ssh.stderr, /exec request failed/);
  },
);
