import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';
import { ExitError } from '@zukhruf/ssh';
import type { Environment } from '@zukhruf/ssh/config';

import { timebox } from '../async/timebox.ts';
import { engine } from '../testing/current-engine.ts';
import {
  library,
  runEnvironment,
  runnerArgs,
} from '../testing/global-setup-run.ts';
import { type Sshd, startSshd } from '../testing/sshd.ts';
import { DockerHost, quote } from './host.ts';
import { TEST_RUN_ID } from './run-records.ts';
import type { ServiceContainer } from './service-container.ts';
import { DockerTestbed } from './testbed.ts';

const run = promisify(execFile);

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;
const noEngine =
  noSshd ||
  (engine.startsWith('unix://')
    ? false
    : `the echo container's port is on this machine only for a local unix:// engine, not ${engine}`);

/** The real ssh of this machine, which `ssh -G` runs. */
const realSsh = noSshd
  ? ''
  : (await run('sh', ['-c', 'command -v ssh'])).stdout.trim();

/** The directory of the docker CLI of this machine, for the PATH of the sessions of an engine host. */
const dockerCli = noEngine
  ? ''
  : dirname(
      await realpath(
        (await run('sh', ['-c', 'command -v docker'])).stdout.trim(),
      ),
    );

/** The engine host of the tests: the `Host` of the ssh_config that `reaching` writes. */
const ENGINE_HOST = 'ssh://engine';

const testbed = new DockerTestbed({ environment: process.env });

/**
 * The environment of a process whose OpenSSH reaches `sshd` as the Host
 * `engine`, through `port`. OpenSSH reads the user's config from the home of
 * the passwd entry, not from HOME, so no variable names a config: the PATH
 * gives an `ssh` that runs the real one with -F. Only `ssh -G` runs it.
 */
async function reaching(sshd: Sshd, port = sshd.port): Promise<Environment> {
  const knownHosts = join(sshd.directory, 'known_hosts');
  await writeFile(
    knownHosts,
    `[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`,
  );
  const config = join(sshd.directory, 'ssh_config');
  await writeFile(
    config,
    [
      `Host ${new URL(ENGINE_HOST).hostname}`,
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${userInfo().username}`,
      `  IdentityFile ${sshd.userKey}`,
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      `  UserKnownHostsFile ${knownHosts}`,
      '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking yes',
      '',
    ].join('\n'),
  );
  const bin = join(sshd.directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec ${quote(realSsh)} -F ${quote(config)} "$@"\n`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:/usr/bin:/bin` };
}

/** A port on 127.0.0.1 where nothing listens: a connect to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function text(stream: Readable): Promise<string> {
  const chunks = await Array.fromAsync(stream, (chunk) => Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Sends `message` to 127.0.0.1:`port`, ends the input, and reads the answer to its end. */
async function echo(port: number, message: string): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  socket.end(message);
  return text(socket);
}

/** A container on the local engine whose port 80 echoes each connection: busybox nc runs cat for each one. */
function echoService(): Promise<ServiceContainer> {
  return testbed.serve(
    { Image: 'alpine:latest', Cmd: ['nc', '-lk', '-p', '80', '-e', 'cat'] },
    {
      internalPort: 80,
      healthy: (service, signal) =>
        timebox(
          async () => assert.equal(await echo(service.port, 'up'), 'up'),
          { signal },
        ),
    },
  );
}

/** An open connection to 127.0.0.1:`port` that has had an answer, so its channel is open at the far end. */
async function openConnection(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  socket.write('ping');
  const [answer]: unknown[] = await once(socket, 'data');
  assert.equal(String(answer), 'ping');
  return socket;
}

/** A Node process that runs `body` with `DockerHost` in scope. */
function nodeWithHost(body: string) {
  const source = `
    import { connect } from 'node:net';
    import { DockerHost } from ${JSON.stringify(new URL('./host.ts', import.meta.url).href)};
    ${body}
  `;
  return ['--no-warnings', '--input-type=module', '--eval', source];
}

test(
  'a lost SSH connection ends the open connections of a forward, and close rejects with the loss',
  { skip: noEngine },
  async () => {
    // Arrange: a connection through the forward has had its answer.
    await using sshd = await startSshd();
    await using service = await echoService();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });
    const forward = await host.forward(service.port);
    const socket = await openConnection(forward.port);
    const ended = once(socket, 'close');

    // Act: the engine host ends every SSH connection.
    sshd.kill('SIGKILL');
    await ended;

    // Assert
    await assert.rejects(forward.close(), {
      message: 'Docker SSH forwarding was lost: ssh: the connection was lost',
    });
  },
);

test(
  'a forward to an engine host that does not answer rejects with the error of the connect',
  { skip: noSshd },
  async () => {
    // Arrange: the config names a port where nothing listens.
    await using sshd = await startSshd();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd, await closedPort()),
    });

    // Act
    const forward = host.forward(80);

    // Assert
    await assert.rejects(forward, { code: 'ECONNREFUSED' });
  },
);

test(
  'a connection to a port where nothing listens on the engine host ends, and is no loss of the forward: close resolves',
  { skip: noSshd },
  async () => {
    // Arrange: a readiness probe connects before its server listens.
    await using sshd = await startSshd();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });
    const forward = await host.forward(await closedPort());
    const socket = connect(forward.port, '127.0.0.1');
    socket.on('error', () => {});

    // Act
    await once(socket, 'close');

    // Assert
    await forward.close();
  },
);

test(
  'a script that exits with a status other than 0 rejects shell with what it printed on stderr',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });

    // Act
    const shell = host.shell("echo 'no such fixture' >&2; exit 3");

    // Assert
    await assert.rejects(shell, (error: Error) => {
      assert.match(error.message, /: no such fixture$/);
      assert.ok(error.cause instanceof ExitError);
      assert.deepEqual(error.cause.exit, { kind: 'status', exitStatus: 3 });
      return true;
    });
  },
);

test(
  'a process killed while its forward carries a connection leaves no process of the connection on the engine host',
  { skip: noEngine },
  async (t) => {
    // Arrange: a process holds a forward with a connection through it.
    await using sshd = await startSshd();
    await using service = await echoService();
    const environment = await reaching(sshd);
    const child = spawn(
      process.execPath,
      nodeWithHost(`
        const host = new DockerHost(${JSON.stringify(ENGINE_HOST)}, { environment: ${JSON.stringify(environment)} });
        const forward = await host.forward(${service.port});
        const socket = connect(forward.port, '127.0.0.1');
        socket.write('ping');
        socket.once('data', () => console.log('carrying'));
      `),
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = once(child, 'exit');
    try {
      const [line]: unknown[] = await once(
        createInterface({ input: child.stdout }),
        'line',
      );
      assert.equal(line, 'carrying');

      // Act
      child.kill('SIGKILL');
      await exited;

      // Assert: each sshd of the process's connections has exited.
      await sshd.connectionsEnded({ signal: t.signal });
    } finally {
      child.kill('SIGKILL');
    }
  },
);

test(
  'close of a forward closes its port and the connections that it carries',
  { skip: noEngine },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using service = await echoService();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });
    const forward = await host.forward(service.port);
    const socket = await openConnection(forward.port);
    const ended = once(socket, 'close');

    // Act
    await forward.close();

    // Assert
    await ended;
    await assert.rejects(echo(forward.port, 'after close'), {
      code: 'ECONNREFUSED',
    });
  },
);

test(
  'a forward carries a connection to the port of the engine host, both ways',
  { skip: noEngine },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using service = await echoService();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });
    const forward = await host.forward(service.port);
    try {
      // Act
      const answer = await echo(forward.port, 'through the engine host');

      // Assert
      assert.equal(answer, 'through the engine host');
    } finally {
      await forward.close();
    }
  },
);

test(
  'shell gives the stdout of a script that reads its input on stdin, with the last newline',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });

    // Act
    const { stdout } = await host.shell('cat', 'first line\nsecond line\n');

    // Assert
    assert.equal(stdout, 'first line\nsecond line\n');
  },
);

test(
  'after its SSH connection was lost, the next shell of the host opens a new one',
  { skip: noEngine },
  async () => {
    // Arrange: the host's connection is lost while a forward carries a connection.
    await using sshd = await startSshd();
    await using service = await echoService();
    const host = new DockerHost(ENGINE_HOST, {
      environment: await reaching(sshd),
    });
    const forward = await host.forward(service.port);
    const socket = await openConnection(forward.port);
    const ended = once(socket, 'close');
    sshd.kill('SIGKILL');
    await ended;
    await forward.close().catch(() => {});

    // Act
    const { stdout } = await host.shell('echo again');

    // Assert
    assert.equal(stdout, 'again\n');
  },
);

test(
  'a run on an ssh:// engine serves its SSH connection to its test processes: the engine at the run’s docker.sock, shells and forwards through its control master, and its teardown removes the run’s sockets',
  { skip: noEngine },
  async () => {
    // Arrange: an engine host whose sessions reach the local engine, and a
    // test file that uses the engine, a directory of the engine host and a
    // forwarded port.
    await using sshd = await startSshd({
      config: [`SetEnv PATH=${dockerCli}:/usr/bin:/bin DOCKER_HOST=${engine}`],
    });
    await using directory = await new TemporaryFiles().directory('ssh-run-');
    const result = join(directory.path, 'result.json');
    const file = join(directory.path, 'engine.test.ts');
    await writeFile(
      file,
      `
      import { test } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      import { connect } from 'node:net';
      import { text } from 'node:stream/consumers';
      import { timebox } from ${JSON.stringify(new URL('../async/index.ts', import.meta.url).href)};
      import { DockerTestbed } from ${library};
      test('the engine of the run', async () => {
        const testbed = new DockerTestbed({ environment: process.env });
        const fixture = await testbed.directory();
        await fixture.writeFile('note.txt', 'through the master');
        const note = await fixture.readFile('note.txt');
        const service = await testbed.serve(
          { Image: 'alpine:latest', Cmd: ['nc', '-lk', '-p', '80', '-e', 'cat'] },
          {
            internalPort: 80,
            healthy: (service, signal) =>
              timebox(async () => {
                const socket = connect(service.port, '127.0.0.1');
                socket.end('up');
                if ((await text(socket)) !== 'up') throw new Error('not up yet');
              }, { signal }),
          },
        );
        await service.disconnect();
        await writeFile(${JSON.stringify(result)}, JSON.stringify({ run: process.env.${TEST_RUN_ID}, dockerHost: process.env.DOCKER_HOST, note }));
      });
      `,
    );
    const runner = spawn(process.execPath, runnerArgs(file), {
      env: {
        ...runEnvironment(join(directory.path, 'state')),
        // A selected context wins over DOCKER_HOST.
        DOCKER_CONTEXT: undefined,
        DOCKER_HOST: ENGINE_HOST,
        PATH: `${(await reaching(sshd)).PATH}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Act
    const [stdout, stderr, [code]] = await Promise.all([
      text(runner.stdout),
      text(runner.stderr),
      once(runner, 'close'),
    ]);

    // Assert
    assert.equal(code, 0, stdout + stderr);
    const { run, dockerHost, note } = JSON.parse(
      await readFile(result, 'utf8'),
    );
    assert.equal(dockerHost, `unix:///tmp/zukhruf-testing-${run}/docker.sock`);
    assert.equal(note, 'through the master');
    assert.equal(existsSync(`/tmp/zukhruf-testing-${run}`), false);
  },
);

test(
  'in a run whose global setup serves no control master, shell fails with the error of the master socket',
  { skip: noSshd },
  async () => {
    // Arrange: a host in a run has no connection of its own.
    await using directory = await new TemporaryFiles().directory('run-');
    const host = new DockerHost(ENGINE_HOST, {
      master: join(directory.path, 'ssh.sock'),
    });

    // Act
    const shell = host.shell('echo on its own');

    // Assert
    await assert.rejects(shell, { code: 'ENOENT' });
  },
);

test(
  'in a run whose control master is gone, a connection to a forward ends, and close rejects with the error of the master socket',
  { skip: noSshd },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('run-');
    const host = new DockerHost(ENGINE_HOST, {
      master: join(directory.path, 'ssh.sock'),
    });
    const forward = await host.forward(80);
    const socket = connect(forward.port, '127.0.0.1');
    socket.on('error', () => {});

    // Act
    await once(socket, 'close');

    // Assert
    await assert.rejects(forward.close(), (error: Error) => {
      assert.match(error.message, /^Docker SSH forwarding was lost: /);
      assert.equal(Reflect.get(Object(error.cause), 'code'), 'ENOENT');
      return true;
    });
  },
);

test(
  'a shell keeps its process alive until the script ends, and the idle connection then lets the process exit',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const environment = await reaching(sshd);

    // Act: nothing but the shell keeps the process alive.
    const { stdout } = await run(
      process.execPath,
      nodeWithHost(`
        const host = new DockerHost(${JSON.stringify(ENGINE_HOST)}, { environment: ${JSON.stringify(environment)} });
        void host.shell('sleep 1; echo done').then(({ stdout }) => process.stdout.write(stdout));
      `),
      { timeout: 30_000, killSignal: 'SIGKILL' },
    );

    // Assert: the output came, and the process ended by itself.
    assert.equal(stdout, 'done\n');
  },
);
