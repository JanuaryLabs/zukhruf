import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { ConnectionFailedError, Docker, DockerError } from './index.ts';
import { IMAGE, TEST_LABEL, removeLabeled } from './testing/engine.ts';
import { ENTRY, runScenario } from './testing/scenario.ts';
import { localEngineSocket } from './testing/ssh-stand-in.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const run = promisify(execFile);

/** The directory of the real docker CLI, or undefined when the PATH has none. */
async function dockerCliDirectory(): Promise<string | undefined> {
  try {
    const { stdout } = await run('sh', ['-c', 'command -v docker']);
    return dirname(await realpath(stdout.trim()));
  } catch (error) {
    // `command -v` exits with 1 when it finds no docker.
    if (Reflect.get(Object(error), 'code') === 1) return undefined;
    throw error;
  }
}

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;
const engineSocket = noSshd ? undefined : await localEngineSocket(process.env);
const dockerCli = noSshd ? undefined : await dockerCliDirectory();
const skip =
  noSshd ||
  (engineSocket === undefined
    ? 'the selected engine is not a local unix:// engine that sshd can reach'
    : dockerCli === undefined
      ? 'the PATH has no docker CLI for the sessions of sshd'
      : false);

/** The Host of the ssh_config of each test. */
const ALIAS = 'engine';
const HOST = `ssh://${ALIAS}`;

/**
 * A real OpenSSH server whose sessions reach the local engine: the docker CLI
 * of a session finds the engine socket through DOCKER_HOST.
 */
async function startEngineSshd(): Promise<Sshd> {
  return startSshd({
    config: [
      `SetEnv PATH=${String(dockerCli)}:/usr/bin:/bin DOCKER_HOST=unix://${String(engineSocket)}`,
    ],
  });
}

/**
 * Writes an ssh_config with the Host ALIAS for `sshd`, and its known hosts
 * file, into the directory of `sshd`, and returns the path of the config.
 */
async function sshConfig(
  sshd: Sshd,
  options: {
    readonly port?: number;
    readonly identityFile?: string;
    readonly knownHosts?: string;
  } = {},
): Promise<string> {
  const knownHosts = join(sshd.directory, 'known_hosts');
  await writeFile(
    knownHosts,
    options.knownHosts ?? `[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`,
  );
  const file = join(sshd.directory, 'ssh_config');
  await writeFile(
    file,
    [
      `Host ${ALIAS}`,
      '  HostName 127.0.0.1',
      `  Port ${options.port ?? sshd.port}`,
      `  User ${userInfo().username}`,
      `  IdentityFile ${options.identityFile ?? sshd.userKey}`,
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      `  UserKnownHostsFile ${knownHosts}`,
      '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking yes',
      '',
    ].join('\n'),
  );
  return file;
}

function connectOverSsh(
  sshFlags: readonly string[],
  signal: AbortSignal,
): Promise<Docker> {
  return Docker.connect({
    clock: globalThis,
    environment: process.env,
    host: HOST,
    sshFlags,
    signal,
  });
}

/** The engine behind sshd, through its socket, with IMAGE on it. */
async function localEngine(signal: AbortSignal): Promise<Docker> {
  const docker = await Docker.connect({
    clock: globalThis,
    host: `unix://${String(engineSocket)}`,
    signal,
  });
  if (!(await docker.images.inspect(IMAGE, { signal }))) {
    await docker.images.pull(IMAGE, { signal });
  }
  return docker;
}

/** The environment of the test process, for a client process that runs as a user's process runs. */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

interface Client extends AsyncDisposable {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  kill(): void;
}

/**
 * Runs `source` as an ES module in a Node process of its own, and waits until
 * it prints `ready`. Disposal kills it if it still runs; so does the signal.
 */
async function startClient(
  source: string,
  signal: AbortSignal,
): Promise<Client> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'inherit'], signal },
  );
  child.on('error', () => {
    // The signal killed the process; 'exit' still comes.
  });
  const exited = once(child, 'exit');
  const { pid } = child;
  if (pid === undefined) throw new Error('The client did not start.');
  const client: Client = {
    pid,
    exited,
    kill: () => child.kill('SIGKILL'),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const first = await Promise.race([
    lines.next(),
    exited.then(([code, exitSignal]: unknown[]) => {
      throw new Error(
        `The client exited before it was ready: ${String(code ?? exitSignal)}`,
      );
    }),
  ]).catch(async (error: unknown) => {
    await client[Symbol.asyncDispose]();
    throw error;
  });
  assert.deepEqual(first, { done: false, value: 'ready' });
  return client;
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

/** `<pid> <command>` of each of the processes that still runs. */
async function running(pids: readonly number[]): Promise<string[]> {
  if (pids.length === 0) return [];
  try {
    const { stdout } = await run('ps', [
      '-o',
      'pid=,command=',
      '-p',
      pids.join(','),
    ]);
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim());
  } catch (error) {
    // ps exits with 1 when no process of the list runs.
    if (Reflect.get(Object(error), 'code') === 1) return [];
    throw error;
  }
}

describe('an engine at an ssh:// host', () => {
  test(
    'info() reaches the engine through the ssh:// host, and host and cliEnvironment give that host',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      const file = await sshConfig(sshd);

      // Act
      await using docker = await connectOverSsh(['-F', file], t.signal);
      const info = await docker.info({ signal: t.signal });

      // Assert
      assert.equal(info.ID, (await local.info({ signal: t.signal })).ID);
      assert.equal(docker.host, HOST);
      assert.deepEqual(docker.cliEnvironment, {
        DOCKER_HOST: HOST,
        DOCKER_CONTEXT: undefined,
      });
    },
  );

  test('two concurrent requests both get their answer', { skip }, async (t) => {
    // Arrange
    await using local = await localEngine(t.signal);
    await using sshd = await startEngineSshd();
    await using docker = await connectOverSsh(
      ['-F', await sshConfig(sshd)],
      t.signal,
    );

    // Act
    const answers = await Promise.all([
      docker.info({ signal: t.signal }),
      docker.info({ signal: t.signal }),
    ]);

    // Assert
    const { ID } = await local.info({ signal: t.signal });
    assert.deepEqual(
      answers.map((answer) => answer.ID),
      [ID, ID],
    );
  });

  test(
    'sshFlags win over the config file: -o Port in the flags wins over the wrong Port of the config',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      const file = await sshConfig(sshd, { port: 1 });

      // Act
      await using docker = await connectOverSsh(
        ['-F', file, '-o', `Port=${sshd.port}`],
        t.signal,
      );
      const info = await docker.info({ signal: t.signal });

      // Assert
      assert.equal(info.ID, (await local.info({ signal: t.signal })).ID);
    },
  );
});

describe('a container over an ssh:// host', () => {
  test(
    'a created and started container runs an exec that gives its stdout and its exit code',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      await using docker = await connectOverSsh(
        ['-F', await sshConfig(sshd)],
        t.signal,
      );
      const run = randomUUID();
      try {
        const container = await docker.containers.create(
          {
            Image: IMAGE,
            Cmd: ['sleep', '3600'],
            Labels: { [TEST_LABEL]: run },
          },
          { signal: t.signal },
        );
        await container.start({ signal: t.signal });

        // Act
        const result = await container.exec(
          { Cmd: ['sh', '-c', 'echo out; exit 3'] },
          { signal: t.signal },
        );

        // Assert
        assert.deepEqual(result, {
          exitCode: 3,
          stdout: 'out\n',
          stderr: '',
          output: 'out\n',
        });
      } finally {
        await removeLabeled(local, run);
      }
    },
  );

  test(
    'stdin of an attach reaches the main process, its stdout comes back with the exit code, and logs() gives the same output',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      await using docker = await connectOverSsh(
        ['-F', await sshConfig(sshd)],
        t.signal,
      );
      const run = randomUUID();
      try {
        const container = await docker.containers.create(
          {
            Image: IMAGE,
            Cmd: ['cat'],
            OpenStdin: true,
            StdinOnce: true,
            Labels: { [TEST_LABEL]: run },
          },
          { signal: t.signal },
        );
        const attached = await container.attach({
          stdin: true,
          signal: t.signal,
        });
        await container.start({ signal: t.signal });
        assert.ok(attached.stdin);
        const input = attached.stdin.getWriter();

        // Act
        await input.write(new TextEncoder().encode('in\n'));
        await input.close();
        const result = await attached.collect();
        const logs = await container.logs({ signal: t.signal });

        // Assert
        assert.deepEqual(result, {
          exitCode: 0,
          stdout: 'in\n',
          stderr: '',
          output: 'in\n',
        });
        assert.deepEqual(logs, { stdout: 'in\n', stderr: '', output: 'in\n' });
      } finally {
        await removeLabeled(local, run);
      }
    },
  );

  test(
    'events() gives the events of a container as they happen: a create that came before the call, then a start that comes after it',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      await using docker = await connectOverSsh(
        ['-F', await sshConfig(sshd)],
        t.signal,
      );
      const run = randomUUID();
      try {
        const container = await docker.containers.create(
          { Image: IMAGE, Labels: { [TEST_LABEL]: run } },
          { signal: t.signal },
        );
        // `since` replays the events that the engine keeps: the create shows
        // that the stream is open before the start.
        const stream = docker.events({
          since: 1,
          filters: { container: [container.id], event: ['create', 'start'] },
          signal: t.signal,
        });
        const events = stream[Symbol.asyncIterator]();
        const created = await events.next();

        // Act
        await container.start({ signal: t.signal });
        const started = await events.next();

        // Assert
        assert.deepEqual(
          [created.value?.Action, started.value?.Action],
          ['create', 'start'],
        );
        assert.equal(started.value?.Actor?.ID, container.id);
      } finally {
        await removeLabeled(local, run);
      }
    },
  );
});

describe('the connections to an ssh:// host', () => {
  test(
    'disposal closes every connection, idle or with an open events() stream: each connection of sshd ends',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      const docker = await connectOverSsh(
        ['-F', await sshConfig(sshd)],
        t.signal,
      );
      const run = randomUUID();
      try {
        await Promise.all([
          docker.info({ signal: t.signal }),
          docker.info({ signal: t.signal }),
        ]);
        const container = await docker.containers.create(
          { Image: IMAGE, Labels: { [TEST_LABEL]: run } },
          { signal: t.signal },
        );
        const stream = docker.events({
          since: 1,
          filters: { container: [container.id], event: ['create'] },
          signal: t.signal,
        });
        const events = stream[Symbol.asyncIterator]();
        await events.next();
        const next = assert.rejects(events.next(), (error) => {
          assert.ok(error instanceof DockerError);
          assert.match(error.message, /disposed/);
          return true;
        });

        // Act
        await docker[Symbol.asyncDispose]();

        // Assert
        await next;
        await sshd.connectionsEnded({ signal: t.signal });
      } finally {
        await removeLabeled(local, run);
      }
    },
  );

  test(
    'a process that connects and never disposes the client exits by itself, and each connection of sshd ends',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd();
      const file = await sshConfig(sshd);
      const source = `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({
  clock: globalThis,
  environment: process.env,
  host: ${JSON.stringify(HOST)},
  sshFlags: ['-F', ${JSON.stringify(file)}],
});
await Promise.all([docker.info(), docker.info()]);
console.log('connected');
`;

      // Act
      const result = await runScenario(
        source,
        inheritedEnvironment(),
        t.signal,
      );

      // Assert
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'connected');
      await sshd.connectionsEnded({ signal: t.signal });
    },
  );

  test(
    'a host key that the known hosts file does not have rejects connect() with a ConnectionFailedError that names the host',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd();
      const file = await sshConfig(sshd, { knownHosts: '' });

      // Act
      const connected = connectOverSsh(['-F', file], t.signal);

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.ok(error.message.includes(HOST), error.message);
        return true;
      });
    },
  );

  test(
    'a user key that sshd refuses rejects connect() with a ConnectionFailedError that names the host',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd();
      const refused = join(sshd.directory, 'refused_ed25519');
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', refused]);
      const file = await sshConfig(sshd, { identityFile: refused });

      // Act
      const connected = connectOverSsh(['-F', file], t.signal);

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.ok(error.message.includes(HOST), error.message);
        return true;
      });
    },
  );

  test(
    'with a keepalive in sshFlags, a call to a machine that stops answering rejects with the ConnectionFailedError of a connection that failed after it opened',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd();
      await using docker = await connectOverSsh(
        [
          '-F',
          await sshConfig(sshd),
          '-o',
          'ServerAliveInterval=1',
          '-o',
          'ServerAliveCountMax=1',
        ],
        t.signal,
      );
      sshd.kill('SIGSTOP');

      // Act
      const info = docker.info({ signal: t.signal });

      // Assert
      await assert.rejects(info, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(
          error.message,
          `Error during the connection to the engine at ${HOST}.`,
        );
        return true;
      });
    },
  );

  test(
    'with a keepalive in sshFlags, an open events() stream to a machine that stops answering rejects with the aborted error of Node, which is not a DockerError',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      await using docker = await connectOverSsh(
        [
          '-F',
          await sshConfig(sshd),
          '-o',
          'ServerAliveInterval=1',
          '-o',
          'ServerAliveCountMax=1',
        ],
        t.signal,
      );
      const run = randomUUID();
      try {
        const container = await docker.containers.create(
          { Image: IMAGE, Labels: { [TEST_LABEL]: run } },
          { signal: t.signal },
        );
        const stream = docker.events({
          since: 1,
          filters: { container: [container.id], event: ['create'] },
          signal: t.signal,
        });
        const events = stream[Symbol.asyncIterator]();
        await events.next();
        sshd.kill('SIGSTOP');

        // Act
        const next = events.next();

        // Assert
        await assert.rejects(next, (error) => {
          assert.ok(!(error instanceof DockerError), String(error));
          assert.equal(Reflect.get(Object(error), 'code'), 'ECONNRESET');
          assert.equal(Reflect.get(Object(error), 'message'), 'aborted');
          return true;
        });
      } finally {
        await removeLabeled(local, run);
      }
    },
  );

  test(
    'when a process that holds an exec of a silent command and an open events() stream dies by SIGKILL, each connection of sshd ends and no process of it remains',
    { skip, todo: '#4503' },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd();
      const file = await sshConfig(sshd);
      const run = randomUUID();
      try {
        const container = await local.containers.create(
          {
            Image: IMAGE,
            Cmd: ['sleep', '3600'],
            Labels: { [TEST_LABEL]: run },
          },
          { signal: t.signal },
        );
        await container.start({ signal: t.signal });
        const source = `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({
  clock: globalThis,
  environment: process.env,
  host: ${JSON.stringify(HOST)},
  sshFlags: ['-F', ${JSON.stringify(file)}],
});
const container = await docker.containers.find(${JSON.stringify(container.id)});
await container.spawn({ Cmd: ['sleep', '3600'] });
const events = docker.events({
  since: 1,
  filters: { container: [container.id], event: ['start'] },
})[Symbol.asyncIterator]();
await events.next();
console.log('ready');
`;
        await using client = await startClient(source, t.signal);
        const ofClient = await descendantsOf(client.pid);
        // Each process of this test, the remote ones too, for the cleanup.
        const ofTest = await descendantsOf(process.pid);
        try {
          // Act
          client.kill();
          await client.exited;

          // Assert
          assert.deepEqual(
            await running(ofClient),
            [],
            'the processes of the client that outlived it',
          );
          await sshd.connectionsEnded({ signal: t.signal });
        } finally {
          for (const line of await running(ofTest)) {
            process.kill(Number.parseInt(line, 10), 'SIGKILL');
          }
        }
      } finally {
        await removeLabeled(local, run);
      }
    },
  );
});
