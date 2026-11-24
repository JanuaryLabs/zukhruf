import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles, isErrno } from '@zukhruf/fs';

import { OpenSshConfig } from './config.ts';
import { hermeticLines } from './testing/ssh-config.ts';
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
  close(): void;
  /** Resolves when the owner has sent `report`, such as `unrefed`. */
  reported(report: string, signal: AbortSignal): Promise<void>;
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
  const sent = new Map<string, PromiseWithResolvers<void>>();
  const awaited = (report: string): PromiseWithResolvers<void> => {
    const resolvers = sent.get(report) ?? Promise.withResolvers<void>();
    sent.set(report, resolvers);
    return resolvers;
  };
  const idle = awaited('idle');
  child.on('message', (report) => {
    reports.push(String(report));
    awaited(String(report)).resolve();
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
    close: () => child.send('close', () => undefined),
    reported: (report, abort) => untilAborted(awaited(report).promise, abort),
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
  return ['Host *', ...hermeticLines(directory)];
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
        } catch (error) {
          // It has exited.
          if (!isErrno(error, 'ESRCH')) throw error;
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
  'a listening control master keeps the process alive: with its client unref’d, the owner exits only after the master.unref() that the test asks for',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using directory = await new TemporaryFiles().directory(
      'master-ref-',
      { parent: '/tmp' },
    );
    await using owner = await startOwner(
      [
        'master',
        String(sshd.port),
        sshd.userKey,
        join(directory.path, 'ssh.sock'),
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
  'ref() after unref() of a control master keeps the process alive again: the owner exits only after the next master.unref()',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using directory = await new TemporaryFiles().directory(
      'master-ref-',
      { parent: '/tmp' },
    );
    await using owner = await startOwner(
      [
        'master',
        String(sshd.port),
        sshd.userKey,
        join(directory.path, 'ssh.sock'),
        '--unref-then-ref',
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

/** An ssh -F config that reaches `sshd` as `box`, with ControlMaster auto and a ControlPath in `directory`. */
async function writeSharingConfig(
  directory: string,
  sshd: Sshd,
): Promise<string> {
  await writeFile(join(directory, 'known_hosts'), knownHost(sshd));
  const file = join(directory, 'ssh_config');
  await writeFile(
    file,
    [
      'Host box',
      '  HostName 127.0.0.1',
      `  Port ${sshd.port}`,
      `  IdentityFile ${sshd.userKey}`,
      '  ControlMaster auto',
      `  ControlPath ${join(directory, 'cm')}`,
      ...hermetic(directory),
      '',
    ].join('\n'),
  );
  return file;
}

test(
  'a process that joined a shared connection exits by itself after unref(), and the master serves on',
  { skip: noSshd },
  async (t) => {
    // Arrange: this process is the master, and the owner joins it.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using master = await config.share({ clock: globalThis });
    await using owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );

    // Act
    owner.unref();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    assert.equal(String(await master.newSession().output('echo ran')), 'ran\n');
    assert.equal(sshd.connections(), 1);
  },
);

test(
  'a master whose own connection is unref()ed keeps serving the process that joined it, and exits by itself once that process closes its connection',
  { skip: noSshd },
  async (t) => {
    // Arrange: the owner is the master, and this process joins it.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    await using owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    const joined = await config.share({ clock: globalThis });
    owner.unref();
    await owner.reported('unrefed', t.signal);
    assert.equal(String(await joined.newSession().output('echo ran')), 'ran\n');

    // Act
    await joined.close();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    await sshd.connectionsEnded({ signal: t.signal });
    assert.equal(sshd.connections(), 1);
  },
);

test(
  'a process that joined a shared connection and holds an idle channel through it exits by itself after unref()',
  { skip: noSshd },
  async (t) => {
    // Arrange: the channel goes to a TCP server of this process, which keeps
    // it open.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using master = await config.share({ clock: globalThis });
    const target = createServer();
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    try {
      await using owner = await startOwner(
        [
          'share',
          file,
          'box',
          directory.path,
          '--hold-dial',
          String(portOf(target)),
        ],
        t.signal,
      );

      // Act
      owner.unref();

      // Assert
      assert.deepEqual(await owner.exited(t.signal), {
        code: 0,
        signal: null,
      });
      assert.equal(sshd.connections(), 1);
    } finally {
      target.close();
    }
  },
);

test(
  'a master that serves no other process ends its connection at close(): the close resolves before the process exits, and the server sees the connection end',
  { skip: noSshd },
  async (t) => {
    // Arrange: the owner is the only process that shares the connection.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    await using owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );

    // Act
    owner.close();

    // Assert
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    assert.deepEqual(owner.reports, ['idle', 'closed', 'exiting']);
    await sshd.connectionsEnded({ signal: t.signal });
  },
);

test(
  'after a master is killed with SIGKILL, share() removes the socket that it left and becomes the master, and the next share() joins it',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    await owner[Symbol.asyncDispose]();
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    await using master = await config.share({ clock: globalThis });
    await using joined = await config.share({ clock: globalThis });

    // Assert
    const outputs = await Promise.all(
      [master, joined].map(async (shared) =>
        String(await shared.newSession().output('echo ran')),
      ),
    );
    assert.deepEqual(outputs, ['ran\n', 'ran\n']);
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'a connection that joined a master whose process is killed with SIGKILL elects again for its next session: it becomes the master, the session runs, and a later share() joins it',
  { skip: noSshd },
  async (t) => {
    // Arrange: the owner is the master, this process joins it, and then the
    // owner dies.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using joined = await config.share({ clock: globalThis });
    await owner[Symbol.asyncDispose]();

    // Act
    const output = String(await joined.newSession().output('echo ran'));
    await using next = await config.share({ clock: globalThis });

    // Assert
    assert.equal(output, 'ran\n');
    assert.equal(String(await next.newSession().output('echo ran')), 'ran\n');
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'a connection that joined a master whose process is killed with SIGKILL holds the master that another process became since: it dials through it with no connection of its own, and keeps it serving after that process closes its use',
  { skip: noSshd },
  async (t) => {
    // Arrange: the first owner is the master and this process joins it,
    // unref'd, so it elects at its next channel; the first owner dies, and
    // the second becomes the master.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const first = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using joined = await config.share({ clock: globalThis });
    joined.unref();
    await first[Symbol.asyncDispose]();
    await using second = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const target = createServer((socket) => socket.end('served'));
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const served = async (): Promise<string> => {
      const channel = await joined.dial('tcp', `127.0.0.1:${portOf(target)}`);
      const received = Buffer.concat(await channel.toArray()).toString();
      channel.destroy();
      return received;
    };
    try {
      // Act
      const before = await served();
      second.close();
      await second.reported('closed', t.signal);
      const after = await served();

      // Assert
      assert.deepEqual([before, after], ['served', 'served']);
      assert.equal(sshd.connections(), 2);
    } finally {
      target.close();
    }
  },
);

test(
  'under ControlMaster no, a connection that joined a master whose process is killed with SIGKILL connects on its own for its next session, as ssh does, and takes no socket: a later share() under auto makes a connection of its own',
  { skip: noSshd },
  async (t) => {
    // Arrange: the owner is the master, this process joins it under
    // ControlMaster no, and then the owner dies.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const environment = { PATH: '/usr/bin:/bin', HOME: directory.path };
    const joining = await OpenSshConfig.resolve('box', {
      flags: ['-F', file, '-o', 'ControlMaster=no'],
      environment,
    });
    await using joined = await joining.share({ clock: globalThis });
    await owner[Symbol.asyncDispose]();

    // Act
    const output = String(await joined.newSession().output('echo ran'));
    const auto = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment,
    });
    await using master = await auto.share({ clock: globalThis });

    // Assert
    assert.equal(output, 'ran\n');
    assert.equal(String(await master.newSession().output('echo ran')), 'ran\n');
    assert.equal(sshd.connections(), 3);
  },
);

test(
  'a process that joined a master whose process is killed with SIGKILL stays alive while its connection is ref’d, and after unref() and a session it exits by itself: the connection of its election stays unref’d',
  { skip: noSshd },
  async (t) => {
    // Arrange: the first owner is the master, the second joins it, and then
    // the first dies.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const master = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    await using joined = await startOwner(
      ['share', file, 'box', directory.path, '--session-after-unref'],
      t.signal,
    );
    await master[Symbol.asyncDispose]();

    // Act
    joined.unref();

    // Assert
    assert.deepEqual(await joined.exited(t.signal), { code: 0, signal: null });
    assert.deepEqual(joined.reports, ['idle', 'unrefed', 'exiting']);
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'an election that fails after the master is killed with SIGKILL rejects that session, and the next session elects again',
  { skip: noSshd },
  async (t) => {
    // Arrange: this process joins the owner's master, unref'd, so it elects
    // at its next channel, and the owner dies. The folder of the socket then
    // refuses the removal of the socket that the owner left: platform setup,
    // as no operation of the package makes the removal fail.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using joined = await config.share({ clock: globalThis });
    joined.unref();
    await owner[Symbol.asyncDispose]();
    await chmod(directory.path, 0o500);
    try {
      await assert.rejects(joined.newSession().output('echo ran'), {
        code: 'EACCES',
      });
    } finally {
      await chmod(directory.path, 0o700);
    }

    // Act
    const output = String(await joined.newSession().output('echo ran'));

    // Assert
    assert.equal(output, 'ran\n');
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'an election that ref() starts after the master is killed with SIGKILL, and that fails while no channel waits for it, is a SharedConnectionWarning with its code, the socket and the failure as its cause',
  { skip: noSshd },
  async (t) => {
    // Arrange: as above, this process joins the owner's master, unref'd, the
    // owner dies, and the folder of the socket refuses the removal of the
    // socket that the owner left: platform setup, as no operation of the
    // package makes the removal fail. A session that fails to elect shows
    // that the connection knows its master is gone.
    const warnings: Error[] = [];
    const warned = Promise.withResolvers<void>();
    const onWarning = (warning: Error) => {
      if (warning.name !== 'SharedConnectionWarning') return;
      warnings.push(warning);
      warned.resolve();
    };
    process.on('warning', onWarning);
    using _listening = {
      [Symbol.dispose]: () => process.off('warning', onWarning),
    };
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    const owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using joined = await config.share({ clock: globalThis });
    joined.unref();
    await owner[Symbol.asyncDispose]();
    await chmod(directory.path, 0o500);
    try {
      await assert.rejects(joined.newSession().output('echo ran'), {
        code: 'EACCES',
      });

      // Act
      joined.ref();
      await untilAborted(warned.promise, t.signal);
    } finally {
      await chmod(directory.path, 0o700);
    }

    // Assert
    const [warning] = warnings;
    assert.equal(warnings.length, 1);
    assert.ok(warning);
    assert.deepEqual(
      { ...warning },
      {
        name: 'SharedConnectionWarning',
        code: 'ZUKHRUF_SSH_SHARED_CONNECTION_ELECTION_FAILED',
        detail: `socket: ${join(directory.path, 'cm')}.zukhruf`,
      },
    );
    assert.ok(isErrno(warning.cause, 'EACCES'));
    assert.match(warning.message, /: EACCES/);
  },
);

test(
  'a connection whose master’s socket was removed, as a cleaner of /tmp removes one, elects again for its next session: it becomes the master, and its hold on the old master ends, so that master’s process exits by itself',
  { skip: noSshd },
  async (t) => {
    // Arrange: the owner is the master, unref'd, so only the hold of this
    // process keeps it alive. Its socket is then removed: platform setup, as
    // no operation of the package removes the socket of a live master.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    await using owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using joined = await config.share({ clock: globalThis });
    owner.unref();
    await owner.reported('unrefed', t.signal);
    await unlink(join(directory.path, 'cm.zukhruf'));

    // Act
    const output = String(await joined.newSession().output('echo ran'));

    // Assert
    assert.equal(output, 'ran\n');
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
    assert.equal(sshd.connections(), 2);
  },
);

test(
  'a master that closed its use and serves only a joined connection ends cleanly when its socket was removed and that connection elects again: its shutdown finds no socket to remove, as OpenSSH ignores the error of that unlink',
  { skip: noSshd },
  async (t) => {
    // Arrange: the owner is the master and this process joins it; the owner
    // closes its use, so it serves only the hold of this process. Its socket
    // is then removed: platform setup, as no operation of the package removes
    // the socket of a live master.
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    const file = await writeSharingConfig(directory.path, sshd);
    await using owner = await startOwner(
      ['share', file, 'box', directory.path],
      t.signal,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using joined = await config.share({ clock: globalThis });
    owner.close();
    await owner.reported('closed', t.signal);
    await unlink(join(directory.path, 'cm.zukhruf'));

    // Act
    const output = String(await joined.newSession().output('echo ran'));

    // Assert
    assert.equal(output, 'ran\n');
    assert.deepEqual(await owner.exited(t.signal), { code: 0, signal: null });
  },
);
