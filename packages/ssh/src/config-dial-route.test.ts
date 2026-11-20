import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { TemporaryFiles, isErrno } from '@zukhruf/fs';

import { OpenSshConfig } from './config.ts';
import { KeyError } from './knownhosts.ts';
import { startSilentServer } from './testing/silent-server.ts';
import { hermeticLines } from './testing/ssh-config.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const noSsh =
  process.platform === 'win32'
    ? 'the tests run OpenSSH ssh and sshd, and a ProxyCommand through a Unix shell'
    : false;

const run = promisify(execFile);

/** `type base64` of a public key line, without its comment. */
function withoutComment(key: string): string {
  return key.split(' ').slice(0, 2).join(' ');
}

async function writeConfig(
  directory: string,
  lines: readonly string[],
): Promise<string> {
  const file = join(directory, 'ssh_config');
  await writeFile(
    file,
    [...lines, 'Host *', ...hermeticLines(directory), ''].join('\n'),
  );
  return file;
}

/** Dials through a ProxyCommand that speaks no SSH, so ssh2 ends the dial before the handshake. */
async function dialWithoutServer(
  config: OpenSshConfig,
  signal: AbortSignal,
): Promise<void> {
  try {
    await config.dial({ clock: createClock(), signal });
  } catch (error) {
    if (
      Error.isError(error) &&
      error.message === 'Connection lost before handshake'
    ) {
      return;
    }
    throw error;
  }
}

/**
 * A ProxyCommand for the tests, run by Node: it connects its stdin and
 * stdout to a TCP port, and ignores the end of its stdin. It reports to a
 * second port its pid, and SIGHUP when it gets it, after which it exits. The
 * connection to the report port keeps it alive.
 *
 *   node proxy.mjs <target port> <report port>
 */
const proxyScript = `
import { connect } from 'node:net';
const [target, report] = process.argv.slice(2).map(Number);
const reporter = connect(report, '127.0.0.1');
reporter.write(process.pid + '\\n');
process.on('SIGHUP', () => reporter.end('SIGHUP\\n', () => process.exit(0)));
const socket = connect(target, '127.0.0.1');
process.stdin.pipe(socket, { end: false });
socket.pipe(process.stdout);
`;

/**
 * A ProxyCommand that passes each end on, as nc does: the end of its stdin
 * ends its connection, and the end of the connection ends the command. It
 * reports its pid to a second port, and its connection to that port does not
 * keep it alive, so that connection ends when the command exits.
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
`;

interface Owner extends AsyncDisposable {
  kill(): void;
}

/** Starts src/testing/config-owner.ts and waits until it is ready. Disposal kills it if it still runs. */
async function startOwner(
  file: string,
  destination: string,
  home: string,
): Promise<Owner> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      new URL('testing/config-owner.ts', import.meta.url).pathname,
      file,
      destination,
      home,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const owner: Owner = {
    kill: () => child.kill('SIGKILL'),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
  if (child.stdout === null) throw new Error('The owner has no stdout.');
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const first = await Promise.race([
    lines.next(),
    exited.then(([code, signal]) => {
      throw new Error(
        `The owner exited before it was ready: ${String(code ?? signal)}`,
      );
    }),
  ]).catch(async (error: unknown) => {
    await owner[Symbol.asyncDispose]();
    throw error;
  });
  assert.deepEqual(first, { done: false, value: 'ready' });
  return owner;
}

interface Reports extends AsyncDisposable {
  readonly port: number;
  /** The pid that the first command reported. */
  pid(signal: AbortSignal): Promise<number>;
  /** The lines of the first command, once its connection to the report port ended. */
  ended(signal: AbortSignal): Promise<string[]>;
}

/** The report port of the proxy script. The dispose ends the reported command if it still runs. */
async function startReports(): Promise<Reports> {
  const connected = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  let received = '';
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    connected.resolve(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: portOf(server),
    async pid(signal) {
      const socket = await connected.promise;
      while (!received.includes('\n')) await once(socket, 'data', { signal });
      return Number(received.split('\n')[0]);
    },
    async ended(signal) {
      const socket = await connected.promise;
      if (!socket.readableEnded) await once(socket, 'end', { signal });
      return received.split('\n').filter((line) => line !== '');
    },
    async [Symbol.asyncDispose]() {
      if (received.includes('\n')) stop(Number(received.split('\n')[0]));
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

/** Ends a process that the test started and that may have ended. */
function stop(pid: number): void {
  try {
    process.kill(pid);
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/** Runs OpenSSH's ssh with the config, and returns when it exits; the ProxyCommands of these tests make it fail. */
async function runOpenSsh(
  file: string,
  destination: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  await run('ssh', ['-F', file, destination, 'true'], {
    env: environment,
  }).catch((error: unknown) => {
    if (!(Error.isError(error) && 'code' in error && error.code === 255)) {
      throw error;
    }
  });
}

test(
  'ProxyUseFdpass yes rejects the dial with an error that names it, and runs no command',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const marker = join(directory.path, 'ran');
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          '  ProxyUseFdpass yes',
          `  ProxyCommand touch ${marker}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, /ProxyUseFdpass/);
    assert.equal(await exists(marker), false);
  },
);

test(
  'ProxyUseFdpass yes on the ProxyCommand of the first jump host rejects the dial',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const marker = join(directory.path, 'ran');
    const config = await OpenSshConfig.resolve('dest', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host jump',
          '  ProxyUseFdpass yes',
          `  ProxyCommand touch ${marker}`,
          'Host dest',
          '  ProxyJump jump',
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, /ProxyUseFdpass/);
    assert.equal(await exists(marker), false);
  },
);

test(
  'a ProxyCommand that exits before the handshake rejects the dial',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          '  ProxyCommand /usr/bin/true',
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, /handshake/i);
  },
);

test(
  'an abort of the signal during the handshake over a ProxyCommand rejects with its reason, and the command gets SIGHUP',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using silent = await startSilentServer();
    await using reports = await startReports();
    const script = join(directory.path, 'proxy.mjs');
    await writeFile(script, proxyScript);
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          `  Port ${silent.port}`,
          `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    const dial = config.dial({
      clock: createClock(),
      signal: AbortSignal.any([controller.signal, t.signal]),
    });
    await reports.pid(t.signal);
    await silent.accepted;

    // Act
    controller.abort(reason);

    // Assert
    await assert.rejects(dial, (error) => error === reason);
    assert.equal((await reports.ended(t.signal)).at(-1), 'SIGHUP');
  },
);

test(
  'the dial runs the handshake over the stdin and stdout of the ProxyCommand, and a session runs',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await using reports = await startReports();
    const script = join(directory.path, 'proxy.mjs');
    await writeFile(script, proxyScript);
    await writeFile(
      join(directory.path, 'known_hosts'),
      `[proxied.invalid]:${sshd.port} ${withoutComment(sshd.hostPublicKey)}\n`,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          '  HostName proxied.invalid',
          `  Port ${sshd.port}`,
          `  IdentityFile ${sshd.userKey}`,
          `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(String(await client.newSession().output('echo ran')), 'ran\n');
  },
);

test(
  'close() sends SIGHUP to a ProxyCommand that ignores the end of its stdin',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await using reports = await startReports();
    const script = join(directory.path, 'proxy.mjs');
    await writeFile(script, proxyScript);
    await writeFile(
      join(directory.path, 'known_hosts'),
      `[proxied.invalid]:${sshd.port} ${withoutComment(sshd.hostPublicKey)}\n`,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          '  HostName proxied.invalid',
          `  Port ${sshd.port}`,
          `  IdentityFile ${sshd.userKey}`,
          `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    const client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });
    await client.newSession().run('true');

    // Act
    await client.close();

    // Assert
    assert.equal((await reports.ended(t.signal)).at(-1), 'SIGHUP');
  },
);

test(
  'a ProxyCommand that exits after the handshake ends the connection, and wait() rejects',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await using reports = await startReports();
    const script = join(directory.path, 'proxy.mjs');
    await writeFile(script, proxyScript);
    await writeFile(
      join(directory.path, 'known_hosts'),
      `[proxied.invalid]:${sshd.port} ${withoutComment(sshd.hostPublicKey)}\n`,
    );
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          '  HostName proxied.invalid',
          `  Port ${sshd.port}`,
          `  IdentityFile ${sshd.userKey}`,
          `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    process.kill(await reports.pid(t.signal), 'SIGKILL');

    // Assert
    await assert.rejects(client.wait());
  },
);

test(
  'the ProxyCommand runs as OpenSSH runs it: <SHELL> -c "exec <command>", with %h %k %n %p %r and %% expanded',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const record = join(directory.path, 'record');
    const shell = join(directory.path, 'shell');
    await writeFile(shell, `#!/bin/sh\nprintf '%s\\n' "$@" > ${record}\n`);
    await chmod(shell, 0o755);
    const file = await writeConfig(directory.path, [
      'Host box',
      '  HostName 127.0.0.1',
      '  Port 2222',
      'Host aliased',
      '  HostName 127.0.0.2',
      '  HostKeyAlias the-alias',
      'Host *',
      '  ProxyCommand connect %h:%p as %r for %n under %k at 100%%',
    ]);
    const environment = {
      PATH: '/usr/bin:/bin',
      HOME: directory.path,
      SHELL: shell,
    };
    const ran: { openSsh: string; dial: string }[] = [];

    for (const destination of [
      'alice@box',
      'ssh://bob@aliased:2200',
      'Mixed.Case',
    ]) {
      await runOpenSsh(file, destination, environment);
      const openSsh = await readFile(record, 'utf8');
      await rm(record);
      const config = await OpenSshConfig.resolve(destination, {
        flags: ['-F', file],
        environment,
      });

      // Act
      await dialWithoutServer(config, t.signal);

      ran.push({ openSsh, dial: await readFile(record, 'utf8') });
    }

    // Assert
    for (const { openSsh, dial } of ran) assert.equal(dial, openSsh);
    assert.equal(
      ran[0]?.dial,
      '-c\nexec connect 127.0.0.1:2222 as alice for box under box at 100%\n',
    );
  },
);

test(
  'without SHELL in the environment, the ProxyCommand runs with /bin/sh, as OpenSSH runs it',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    // The command names a directory after "$0", the shell that ran it; it
    // keeps its stdout open until it exits, so neither client hangs it up
    // before it ran.
    const ran = join(directory.path, 'ran');
    const file = await writeConfig(directory.path, [
      'Host box',
      `  ProxyCommand mkdir -p ${ran}"$0"`,
    ]);
    const environment = { PATH: '/usr/bin:/bin', HOME: directory.path };
    await runOpenSsh(file, 'box', environment);
    const openSsh = await exists(join(ran, 'bin', 'sh'));
    await rm(ran, { recursive: true });
    const config = await OpenSshConfig.resolve('box', {
      flags: ['-F', file],
      environment,
    });

    // Act
    await dialWithoutServer(config, t.signal);

    // Assert
    assert.equal(openSsh, true);
    assert.equal(await exists(join(ran, 'bin', 'sh')), true);
  },
);

test(
  'when the owner of a connection over a ProxyCommand dies by SIGKILL, the command ends and the server has no connection left',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using sshd = await startSshd();
    await using reports = await startReports();
    const script = join(directory.path, 'relay.mjs');
    await writeFile(script, relayScript);
    await writeFile(
      join(directory.path, 'known_hosts'),
      `[proxied.invalid]:${sshd.port} ${withoutComment(sshd.hostPublicKey)}\n`,
    );
    const file = await writeConfig(directory.path, [
      'Host box',
      '  HostName proxied.invalid',
      `  Port ${sshd.port}`,
      `  IdentityFile ${sshd.userKey}`,
      `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
    ]);
    await using owner = await startOwner(file, 'box', directory.path);
    await reports.pid(t.signal);

    // Act
    owner.kill();

    // Assert
    await reports.ended(t.signal);
    await sshd.connectionsEnded({ signal: t.signal });
  },
);

test(
  'the ProxyCommand gets the environment of the config as its whole environment',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const record = join(directory.path, 'record');
    const config = await OpenSshConfig.resolve('box', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host box',
          // A builtin of a shell that runs on keeps the stdout of the command
          // open until it wrote.
          `  ProxyCommand sh -c 'printf "%%s|%%s" "$MARK" "\${NODE_TEST_CONTEXT-unset}" > ${record}; exit 0'`,
        ]),
      ],
      environment: {
        PATH: '/usr/bin:/bin',
        HOME: directory.path,
        MARK: 'from the config',
      },
    });

    // Act
    await dialWithoutServer(config, t.signal);

    // Assert
    assert.equal(await readFile(record, 'utf8'), 'from the config|unset');
  },
);

test(
  'the stderr of the ProxyCommand is the stderr of the Node process',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    const file = await writeConfig(directory.path, [
      'Host box',
      // The builtin echo of a shell that runs on keeps the stdout of the
      // command open, so neither end hangs the command up before it wrote.
      "  ProxyCommand sh -c 'echo said on stderr >&2; exit 0'",
    ]);
    const owner = spawn(
      process.execPath,
      [
        new URL('testing/config-owner.ts', import.meta.url).pathname,
        file,
        'box',
        directory.path,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], signal: t.signal },
    );
    let stderr = '';
    owner.stderr.setEncoding('utf8');
    owner.stderr.on('data', (chunk: string) => (stderr += chunk));

    // Act
    await once(owner, 'close', { signal: t.signal });

    // Assert
    assert.match(stderr, /^said on stderr$/m);
  },
);

/** A config that reaches `dest` through `jump`, each with its own sshd, key and known hosts line. */
async function jumpConfig(
  directory: string,
  jump: Sshd,
  dest: Sshd,
  options: { readonly jumpLines?: readonly string[] } = {},
): Promise<string> {
  return writeConfig(directory, [
    'Host jump',
    ...(options.jumpLines ?? []),
    '  HostName 127.0.0.1',
    `  Port ${jump.port}`,
    `  IdentityFile ${jump.userKey}`,
    'Host dest',
    '  HostName 127.0.0.1',
    `  Port ${dest.port}`,
    '  ProxyJump jump',
    `  IdentityFile ${dest.userKey}`,
  ]);
}

test(
  'through a ProxyJump jump host, a session runs on the destination',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd({ config: ['SetEnv WHO=dest'] });
    await writeFile(
      join(directory.path, 'known_hosts'),
      [jump, dest]
        .map(
          (each) =>
            `[127.0.0.1]:${each.port} ${withoutComment(each.hostPublicKey)}\n`,
        )
        .join(''),
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: ['-F', await jumpConfig(directory.path, jump, dest)],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(
      String(await client.newSession().output('printf %s "$WHO"')),
      'dest',
    );
  },
);

test(
  'through two jump hosts, a session runs on the destination, and close() ends the connections of both jump hosts',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using second = await startSshd();
    // The first jump host opens a channel only to the second one, so the
    // destination is reached only through both.
    await using first = await startSshd({
      config: [`PermitOpen 127.0.0.1:${second.port}`],
    });
    await using dest = await startSshd({ config: ['SetEnv WHO=dest'] });
    await writeFile(
      join(directory.path, 'known_hosts'),
      [first, second, dest]
        .map(
          (each) =>
            `[127.0.0.1]:${each.port} ${withoutComment(each.hostPublicKey)}\n`,
        )
        .join(''),
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host first',
          '  HostName 127.0.0.1',
          `  Port ${first.port}`,
          `  IdentityFile ${first.userKey}`,
          'Host second',
          '  HostName 127.0.0.1',
          `  Port ${second.port}`,
          `  IdentityFile ${second.userKey}`,
          'Host dest',
          '  HostName 127.0.0.1',
          `  Port ${dest.port}`,
          '  ProxyJump first,second',
          `  IdentityFile ${dest.userKey}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    const client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });
    const who = String(await client.newSession().output('printf %s "$WHO"'));

    // Act
    await client.close();

    // Assert
    assert.equal(who, 'dest');
    await second.connectionsEnded({ signal: t.signal });
    await first.connectionsEnded({ signal: t.signal });
  },
);

test(
  'a jump host in the restricted mode of StrictHostKeyChecking no still dials the next host, so the chain goes on',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd({ config: ['SetEnv WHO=dest'] });
    await writeFile(
      join(directory.path, 'known_hosts'),
      [
        `[127.0.0.1]:${jump.port} ${withoutComment(dest.hostPublicKey)}`,
        `[127.0.0.1]:${dest.port} ${withoutComment(dest.hostPublicKey)}`,
        '',
      ].join('\n'),
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: [
        '-F',
        await jumpConfig(directory.path, jump, dest, {
          jumpLines: ['  StrictHostKeyChecking no'],
        }),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(
      String(await client.newSession().output('printf %s "$WHO"')),
      'dest',
    );
  },
);

test(
  'the destination is reached through a channel of the jump host: a jump host that refuses TCP forwarding fails the dial',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd({ config: ['AllowTcpForwarding no'] });
    await using dest = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      [jump, dest]
        .map(
          (each) =>
            `[127.0.0.1]:${each.port} ${withoutComment(each.hostPublicKey)}\n`,
        )
        .join(''),
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: ['-F', await jumpConfig(directory.path, jump, dest)],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, /the server refused the channel/);
  },
);

test(
  'close() of the destination client closes the client of the jump host',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      [jump, dest]
        .map(
          (each) =>
            `[127.0.0.1]:${each.port} ${withoutComment(each.hostPublicKey)}\n`,
        )
        .join(''),
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: ['-F', await jumpConfig(directory.path, jump, dest)],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });
    const client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Act
    await client.close();

    // Assert
    await jump.connectionsEnded({ signal: t.signal });
  },
);

test(
  'the host key of the destination is checked under its own name and policy, and its refusal closes the client of the jump host',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      `[127.0.0.1]:${jump.port} ${withoutComment(jump.hostPublicKey)}\n`,
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: [
        '-F',
        await jumpConfig(directory.path, jump, dest, {
          jumpLines: ['  StrictHostKeyChecking no'],
        }),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    const dial = config.dial({ clock: createClock(), signal: t.signal });

    // Assert
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof KeyError);
      assert.match(
        error.message,
        new RegExp(`\\[127\\.0\\.0\\.1\\]:${dest.port}`),
      );
      return true;
    });
    await jump.connectionsEnded({ signal: t.signal });
  },
);

test(
  'the first jump host is reached by its own ProxyCommand',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd({ config: ['SetEnv WHO=dest'] });
    await using reports = await startReports();
    const script = join(directory.path, 'proxy.mjs');
    await writeFile(script, proxyScript);
    await writeFile(
      join(directory.path, 'known_hosts'),
      [
        `[jump.invalid]:${jump.port} ${withoutComment(jump.hostPublicKey)}`,
        `[127.0.0.1]:${dest.port} ${withoutComment(dest.hostPublicKey)}`,
        '',
      ].join('\n'),
    );
    const config = await OpenSshConfig.resolve('dest', {
      flags: [
        '-F',
        await writeConfig(directory.path, [
          'Host jump',
          '  HostName jump.invalid',
          `  IdentityFile ${jump.userKey}`,
          `  Port ${jump.port}`,
          `  ProxyCommand ${process.execPath} ${script} %p ${reports.port}`,
          'Host dest',
          '  HostName 127.0.0.1',
          `  Port ${dest.port}`,
          '  ProxyJump jump',
          `  IdentityFile ${dest.userKey}`,
        ]),
      ],
      environment: { PATH: '/usr/bin:/bin', HOME: directory.path },
    });

    // Act
    await using client = await config.dial({
      clock: createClock(),
      signal: t.signal,
    });

    // Assert
    assert.equal(
      String(await client.newSession().output('printf %s "$WHO"')),
      'dest',
    );
  },
);

test(
  'when the owner of a connection through a jump host dies by SIGKILL, neither the jump host nor the destination has a connection left',
  { skip: noSsh },
  async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('ssh-', {
      parent: '/tmp',
    });
    await using jump = await startSshd();
    await using dest = await startSshd();
    await writeFile(
      join(directory.path, 'known_hosts'),
      [jump, dest]
        .map(
          (each) =>
            `[127.0.0.1]:${each.port} ${withoutComment(each.hostPublicKey)}\n`,
        )
        .join(''),
    );
    await using owner = await startOwner(
      await jumpConfig(directory.path, jump, dest),
      'dest',
      directory.path,
    );

    // Act
    owner.kill();

    // Assert
    await jump.connectionsEnded({ signal: t.signal });
    await dest.connectionsEnded({ signal: t.signal });
  },
);

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}
