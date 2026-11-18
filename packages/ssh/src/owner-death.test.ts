import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { untilAborted } from '@zukhruf/async';
import { isErrno } from '@zukhruf/fs';

import { type Sshd, startSshd } from './testing/sshd.ts';

const run = promisify(execFile);
const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

/** A command that writes nothing and ends when sshd closes its stdin. */
const silentCommand = 'exec cat > /dev/null';

interface Owner extends AsyncDisposable {
  readonly pid: number;
  kill(): void;
}

/**
 * Starts src/testing/owner.ts, which holds a session that runs `command` and a
 * channel dialed to `address`, and waits until it is ready. Disposal kills it
 * if it still runs.
 */
async function startOwner(
  sshd: Sshd,
  address: string,
  command: string,
): Promise<Owner> {
  const child = spawn(
    process.execPath,
    [
      new URL('testing/owner.ts', import.meta.url).pathname,
      String(sshd.port),
      sshd.userKey,
      address,
      command,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const owner: Owner = {
    pid: pidOf(child),
    kill: () => child.kill('SIGKILL'),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
  const lines = createInterface({ input: child.stdout! })[
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

function pidOf(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error('The owner did not start.');
  return child.pid;
}

interface Listener extends AsyncDisposable {
  /** host:port on 127.0.0.1, or the socket path. */
  readonly address: string;
}

/**
 * A server on a free port of 127.0.0.1, or on a Unix socket path, that gives
 * each connection it accepts to `accepted`. Disposal destroys the connections
 * that are still open: one that a failed test leaves open would keep
 * `close()` waiting.
 */
async function listen(
  path: string | undefined,
  accepted: (socket: Socket) => void = () => undefined,
): Promise<Listener> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.resume();
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

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
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

/** Each process below `pid` in the process tree, from a ps listing that macOS and Linux procps both give. */
async function descendantsOf(pid: number): Promise<number[]> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of stdout.trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const descendants: number[] = [];
  const pending = [pid];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const below = children.get(next) ?? [];
    descendants.push(...below);
    pending.push(...below);
  }
  return descendants;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid now belongs to a process of another user.
    if (isErrno(error, 'ESRCH') || isErrno(error, 'EPERM')) return false;
    throw error;
  }
}

test(
  'while the owner holds a session and a dialed channel, the package runs no process of its own',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using remote = await listen(undefined);
    await using owner = await startOwner(sshd, remote.address, silentCommand);

    // Act
    const descendants = await descendantsOf(owner.pid);

    // Assert
    try {
      assert.deepEqual(descendants, []);
    } finally {
      for (const pid of descendants) {
        if (isRunning(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  },
);

test(
  'when the owner dies by SIGKILL, the remote TCP server sees the dialed connection close',
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    const accepted = Promise.withResolvers<Socket>();
    await using server = await listen(undefined, (socket) =>
      accepted.resolve(socket),
    );
    await using owner = await startOwner(sshd, server.address, silentCommand);
    const dialed = await untilAborted(accepted.promise, t.signal);
    const closed = once(dialed, 'close', { signal: t.signal });

    // Act
    owner.kill();

    // Assert
    await closed;
  },
);

test(
  "when the owner dies by SIGKILL, each sshd process of the connection exits, and the session's command ends",
  { skip: noSshd },
  async (t) => {
    // Arrange
    await using sshd = await startSshd();
    await using remote = await listen(undefined);
    const running = Promise.withResolvers<Socket>();
    await using commands = await listen(
      join(sshd.directory, 'command.sock'),
      (socket) => running.resolve(socket),
    );
    await using owner = await startOwner(
      sshd,
      remote.address,
      commandOn(commands.address),
    );
    const command = await untilAborted(running.promise, t.signal);
    const ended = once(command, 'close', { signal: t.signal });

    // Act
    owner.kill();

    // Assert
    await sshd.connectionsEnded({ signal: t.signal });
    await ended;
  },
);
