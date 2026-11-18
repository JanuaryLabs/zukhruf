import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';

import { type Sshd, startSshd } from './testing/sshd.ts';

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

/** Longer than any test runs: a timer of this length that keeps the process alive fails the test at its limit. */
const anHour = String(60 * 60 * 1000);

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface Owner extends AsyncDisposable {
  /** The reports of the owner so far, in order. */
  readonly reports: readonly string[];
  unref(): void;
  /** Resolves when the owner has exited and its IPC channel has closed. */
  exited(signal: AbortSignal): Promise<Exit>;
}

/**
 * Starts src/testing/ref-owner.ts with `args`, and waits until it reports
 * `idle`. Disposal kills it if it still runs.
 */
async function startOwner(
  args: readonly string[],
  signal: AbortSignal,
): Promise<Owner> {
  const child = spawn(
    process.execPath,
    [new URL('testing/ref-owner.ts', import.meta.url).pathname, ...args],
    { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
  );
  const reports: string[] = [];
  const idle = Promise.withResolvers<void>();
  child.on('message', (report) => {
    reports.push(String(report));
    if (report === 'idle') idle.resolve();
  });
  const closed = new Promise<Exit>((resolve) =>
    child.once('close', (code, exitSignal) =>
      resolve({ code, signal: exitSignal }),
    ),
  );
  const owner: Owner = {
    reports,
    // An owner that exited before the command gets no command.
    unref: () => child.send('unref', () => undefined),
    exited: (abort) => untilAborted(closed, abort),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await closed;
    },
  };
  try {
    await untilAborted(
      Promise.race([
        idle.promise,
        closed.then((exit) => {
          throw new Error(
            `The owner exited before it was idle: ${JSON.stringify(exit)}`,
          );
        }),
      ]),
      signal,
    );
  } catch (error) {
    await owner[Symbol.asyncDispose]();
    throw error;
  }
  return owner;
}

/** The known hosts line of `sshd` on 127.0.0.1. */
function knownHost(sshd: Sshd): string {
  return `[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`;
}

/** The lines of a `Host *` block that keep ssh -G to the files of the test, with the host key policy `yes` and no agent. */
function hermetic(directory: string): string[] {
  return [
    'Host *',
    `  User ${userInfo().username}`,
    `  UserKnownHostsFile ${join(directory, 'known_hosts')}`,
    '  GlobalKnownHostsFile /dev/null',
    '  IdentityAgent none',
    '  StrictHostKeyChecking yes',
  ];
}

/**
 * A ProxyCommand that passes each end on, as nc does, and reports its pid to
 * a second port; its connection to that port does not keep it alive, so that
 * connection ends when the command exits. A write to its stdout after the
 * owner exited ends the relay.
 *
 *   node relay.mjs <target port> <report port>
 */
const relayScript = `
import { connect } from 'node:net';
const [target, report] = process.argv.slice(2).map(Number);
const reporter = connect(report, '127.0.0.1');
reporter.write(process.pid + '\\n');
reporter.unref();
const socket = connect(target, '127.0.0.1');
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdout.on('error', () => socket.destroy());
`;

interface Reports extends AsyncDisposable {
  readonly port: number;
  /** Resolves when the connection of the command to the report port ends. */
  ended(signal: AbortSignal): Promise<void>;
}

/** The report port of the relay. Disposal ends the command if it still runs, and destroys the connections. */
async function startReports(): Promise<Reports> {
  const connected = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  let received = '';
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('error', () => undefined);
    connected.resolve(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: portOf(server),
    async ended(signal) {
      const socket = await untilAborted(connected.promise, signal);
      if (!socket.readableEnded) await once(socket, 'end', { signal });
    },
    async [Symbol.asyncDispose]() {
      const pid = Number(received.split('\n')[0]);
      if (pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // It has exited.
        }
      }
      for (const socket of sockets) socket.destroy();
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
  };
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}

test(
  'a new client keeps the process alive: the owner exits only after the unref() that the test asks for',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      ['dial', String(sshd.port), sshd.userKey],
      t.signal,
    );

    // Act
    owner.unref();
    const exit = await owner.exited(t.signal);

    // Assert
    assert.deepEqual(owner.reports, ['idle', 'unrefed', 'exiting']);
    assert.deepEqual(exit, { code: 0, signal: null });
  },
);

test(
  "after unref(), the owner exits by itself, and the server sees the client's connection end",
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      ['dial', String(sshd.port), sshd.userKey],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    await sshd.connectionsEnded({ signal: t.signal });
  },
);

test(
  'ref() after unref() keeps the process alive again: the owner exits only after the next unref()',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      ['dial', String(sshd.port), sshd.userKey, '--unref-then-ref'],
      t.signal,
    );

    // Act
    owner.unref();
    const exit = await owner.exited(t.signal);

    // Assert
    assert.deepEqual(owner.reports, ['idle', 'unrefed', 'exiting']);
    assert.deepEqual(exit, { code: 0, signal: null });
  },
);

test(
  'with a keepalive, the owner exits after unref(): the keepalive timer is unref’d with the client',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      ['dial', String(sshd.port), sshd.userKey, '--keepalive', anHour],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
  },
);

test(
  'with a keepalive, the owner exits after unref() that comes after a session, whose channel request reply resets the keepalive timer',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      [
        'dial',
        String(sshd.port),
        sshd.userKey,
        '--keepalive',
        anHour,
        '--session',
      ],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
  },
);

test(
  'with a keepalive, the owner exits after a session that comes after unref(): the timer that its reply resets stays unref’d',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      [
        'dial',
        String(sshd.port),
        sshd.userKey,
        '--keepalive',
        anHour,
        '--session-after-unref',
      ],
      t.signal,
    );

    // Act
    owner.unref();
    const exit = await owner.exited(t.signal);

    // Assert
    assert.deepEqual(owner.reports, ['idle', 'unrefed', 'exiting']);
    assert.deepEqual(exit, { code: 0, signal: null });
  },
);

test(
  'over a stream of the caller with no ref() or unref(), the owner exits after it unrefs its socket and the client, after a keepalive reply reset the keepalive timer',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      ['handshake', String(sshd.port), sshd.userKey, '--keepalive', '50'],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
  },
);

test(
  'over a stream of the caller, the keepalive timers that come after unref() stay unref’d: the owner exits after two more keepalive replies',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      [
        'handshake',
        String(sshd.port),
        sshd.userKey,
        '--keepalive',
        '50',
        '--replies-after-unref',
        '2',
      ],
      t.signal,
    );

    // Act
    owner.unref();
    const exit = await owner.exited(t.signal);

    // Assert
    assert.deepEqual(owner.reports, ['idle', 'unrefed', 'exiting']);
    assert.deepEqual(exit, { code: 0, signal: null });
  },
);

test(
  'with a connectTimeout, the owner exits after unref(): no timer of the connect holds the process',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using owner = await startOwner(
      ['dial', String(sshd.port), sshd.userKey, '--connect-timeout', anHour],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
  },
);

test(
  'through a ProxyJump jump host, the owner exits after unref(), and both servers see their connections end',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      knownHost(jump) + knownHost(dest),
    );
    const file = join(directory.path, 'ssh_config');
    await writeFile(
      file,
      [
        'Host jump',
        '  HostName 127.0.0.1',
        `  Port ${jump.port}`,
        `  IdentityFile ${jump.userKey}`,
        'Host dest',
        '  HostName 127.0.0.1',
        `  Port ${dest.port}`,
        '  ProxyJump jump',
        `  IdentityFile ${dest.userKey}`,
        ...hermetic(directory.path),
        '',
      ].join('\n'),
    );
    await using owner = await startOwner(
      ['config', file, 'dest', directory.path],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    await dest.connectionsEnded({ signal: t.signal });
    await jump.connectionsEnded({ signal: t.signal });
  },
);

test(
  'over a ProxyCommand, the owner exits after unref(), the command ends, and the server sees the connection end',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await using reports = await startReports();
    const script = join(directory.path, 'relay.mjs');
    await writeFile(script, relayScript);
    await writeFile(join(directory.path, 'known_hosts'), knownHost(sshd));
    const file = join(directory.path, 'ssh_config');
    await writeFile(
      file,
      [
        'Host box',
        '  HostName 127.0.0.1',
        `  Port ${sshd.port}`,
        `  IdentityFile ${sshd.userKey}`,
        `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
        ...hermetic(directory.path),
        '',
      ].join('\n'),
    );
    await using owner = await startOwner(
      ['config', file, 'box', directory.path],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    await reports.ended(t.signal);
    await sshd.connectionsEnded({ signal: t.signal });
  },
);
