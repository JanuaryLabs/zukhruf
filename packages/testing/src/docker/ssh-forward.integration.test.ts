import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';

import spawn from 'nano-spawn';

import { TemporaryFiles } from '../fs/temporary-files.ts';
import { fakeEngine } from '../testing/fake-engine.ts';

const skip =
  process.platform === 'win32'
    ? 'the ssh stand-in is a POSIX executable'
    : false;

/** The container that the engine stand-in creates. */
const CONTAINER = 'standin-container';

/**
 * Stands in for OpenSSH. `ssh … docker system dial-stdio` pipes its stdin and
 * stdout to the engine stand-in's socket, named in `engine-socket`, as the
 * Docker CLI does on the engine's host. `ssh -L <socket>:127.0.0.1:<port>
 * <host> 'cat >/dev/null'` is the forward: it exits when its stdin ends, as
 * the remote `cat` does. `ssh-mode` picks the forward's behavior: `serve`
 * opens the socket, `refused` fails to connect, `silent` never opens the
 * socket, `stubborn` stays up after its stdin ends. A `lose` file ends the
 * forward the way a dead connection does, and a `stdin-ended` file records
 * that its stdin ended. Messages are OpenSSH's.
 */
const sshStandIn = `#!${process.execPath}
const { connect, createServer } = require('node:net');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
if (process.argv.includes('dial-stdio')) {
  const socket = connect(readFileSync(join(__dirname, 'engine-socket'), 'utf8'));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
} else {
  writeFileSync(join(__dirname, 'ssh.pid'), String(process.pid));
  const mode = readFileSync(join(__dirname, 'ssh-mode'), 'utf8').trim();
  if (mode === 'refused') {
    process.stderr.write('ssh: connect to host sshhost port 22: Connection refused\\n');
    process.exit(255);
  }
  if (process.argv.at(-1) === 'cat >/dev/null') {
    process.stdin.resume();
    process.stdin.on('end', () => {
      writeFileSync(join(__dirname, 'stdin-ended'), '');
      if (mode !== 'stubborn') process.exit(0);
    });
  }
  if (mode !== 'silent') {
    const spec = process.argv[process.argv.indexOf('-L') + 1];
    createServer().listen(spec.slice(0, spec.lastIndexOf(':127.0.0.1:')));
  }
  setInterval(() => {
    if (existsSync(join(__dirname, 'lose'))) {
      process.stderr.write('Timeout, server sshhost not responding.\\n');
      process.exit(255);
    }
  }, 20);
}
`;

/**
 * Answers what serve() and cleanup() ask an engine for one container whose
 * port 5432 is published on the engine host's 127.0.0.1:49999. With
 * `removalFails`, the engine refuses the container's removal.
 */
const engineAnswer =
  ({ removalFails }: { removalFails: boolean }) =>
  (request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    const path = new URL(request.url ?? '', 'http://engine').pathname.replace(
      /^\/v[\d.]+/,
      '',
    );
    const answer = (status: number, body?: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const route = `${request.method} ${path}`;
    if (route === 'POST /containers/create')
      return answer(201, { Id: CONTAINER, Warnings: [] });
    if (route === `POST /containers/${CONTAINER}/start`) return answer(204);
    if (route === `GET /containers/${CONTAINER}/json`)
      return answer(200, {
        Id: CONTAINER,
        NetworkSettings: {
          Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49999' }] },
        },
      });
    if (route === `DELETE /containers/${CONTAINER}`)
      return removalFails
        ? answer(500, { message: 'the engine stand-in refuses the removal' })
        : answer(204);
    return answer(404, { message: `unexpected: ${route}` });
  };

/**
 * A directory holding the ssh stand-in, with its forward in `mode`, and an
 * engine stand-in that the stand-in's dial-stdio reaches. Disposal stops the
 * engine, then removes the directory.
 */
async function standIns(
  mode: string,
  { withSsh = true, removalFails = false } = {},
) {
  const resources = new AsyncDisposableStack();
  try {
    const directory = await new TemporaryFiles().directory(
      'zukhruf-testing-ssh-',
    );
    resources.use(directory);
    const engine = resources.use(
      await fakeEngine({
        directory: directory.path,
        apiVersion: '1.51',
        answer: engineAnswer({ removalFails }),
      }),
    );
    if (withSsh)
      await writeFile(join(directory.path, 'ssh'), sshStandIn, {
        mode: 0o755,
      });
    await writeFile(join(directory.path, 'ssh-mode'), mode);
    await writeFile(join(directory.path, 'engine-socket'), engine.socketPath);
    const stack = resources.move();
    return {
      path: directory.path,
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}

/**
 * Runs `body` in a new Node process whose PATH starts with the stand-ins and
 * whose DOCKER_HOST is an ssh:// engine. `body` prints one JSON line.
 */
async function scenario(directory: string, body: string, path?: string) {
  const source = `
    import { connect } from 'node:net';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { DockerTestbed } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const directory = ${JSON.stringify(directory)};
    const testbed = new DockerTestbed({ environment: process.env });
    const failure = (error) => ({
      message: error.message,
      cause: error.cause && { name: error.cause.name, message: error.cause.message, exitCode: error.cause.exitCode, code: error.cause.code, cause: error.cause.cause?.message },
      error: error.error?.message,
      suppressed: error.suppressed?.message,
    });
    const settled = (promise) => promise.then(() => 'resolved', failure);
    // null when ssh never started: a missing pid must not read as "stopped".
    const sshAlive = () => {
      if (!existsSync(directory + '/ssh.pid')) return null;
      try { process.kill(Number(readFileSync(directory + '/ssh.pid', 'utf8')), 0); return true; }
      catch { return false; }
    };
    const refuses = (port) => new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(true));
    });
    ${body}
  `;
  const { stdout, stderr } = await spawn(
    process.execPath,
    ['--no-warnings', '--input-type=module', '--eval', source],
    {
      env: {
        PATH: path ?? `${directory}:${process.env.PATH}`,
        DOCKER_HOST: 'ssh://tester@sshhost',
        DOCKER_CONTEXT: undefined,
      },
    },
  );
  return { result: JSON.parse(stdout.split('\n').at(-1)!), stderr };
}

test(
  'a forward lost after it started makes disconnect reject with what ssh said',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: the forward is up.
    await using directory = await standIns('serve');

    // Act: the connection dies, then the test lets the server go.
    const { result, stderr } = await scenario(
      directory.path,
      `
      const server = await testbed.serve({ Image: 'standin' }, { internalPort: 5432 });
      writeFileSync(directory + '/lose', '');
      while (!(await refuses(server.port))) await delay(20);
      console.log(JSON.stringify({ disconnect: await settled(server.disconnect()) }));
      `,
    );

    // Assert
    assert.equal(
      result.disconnect.message,
      'Docker SSH forwarding was lost: Timeout, server sshhost not responding.',
    );
    assert.equal(stderr, '');
  },
);

test(
  'cleanup keeps both errors when the container removal fails and the forward was lost',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: the forward is up, and the engine will refuse the removal.
    await using directory = await standIns('serve', { removalFails: true });

    // Act
    const { result } = await scenario(
      directory.path,
      `
      const server = await testbed.serve({ Image: 'standin' }, { internalPort: 5432 });
      writeFileSync(directory + '/lose', '');
      while (!(await refuses(server.port))) await delay(20);
      console.log(JSON.stringify({ cleanup: await settled(server.cleanup()) }));
      `,
    );

    // Assert: neither failure hides the other.
    const messages = [
      result.cleanup.message,
      result.cleanup.error,
      result.cleanup.suppressed,
    ];
    assert.ok(
      messages.includes(
        'Docker SSH forwarding was lost: Timeout, server sshhost not responding.',
      ),
      JSON.stringify(result.cleanup),
    );
    assert.ok(
      messages.includes('the engine stand-in refuses the removal'),
      JSON.stringify(result.cleanup),
    );
  },
);

test(
  'an ssh that fails to start rejects serve with what ssh said, and prints nothing',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: ssh cannot reach the engine's host.
    await using directory = await standIns('refused');

    // Act
    const { result, stderr } = await scenario(
      directory.path,
      `console.log(JSON.stringify({
        serve: await settled(testbed.serve({ Image: 'standin' }, { internalPort: 5432 })),
      }));`,
    );

    // Assert: one error carries the reason; nothing is written beside it.
    assert.equal(
      result.serve.message,
      'Docker SSH forwarding exited: ssh: connect to host sshhost port 22: Connection refused',
    );
    assert.equal(result.serve.cause.exitCode, 255);
    assert.equal(stderr, '');
  },
);

test(
  'a machine without ssh fails the first acquisition at once: Docker is required, and the connection failure as cause',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: PATH holds no ssh.
    await using directory = await standIns('serve', { withSsh: false });

    // Act
    const { result } = await scenario(
      directory.path,
      `const started = performance.now();
      const serve = await settled(testbed.serve({ Image: 'standin' }, { internalPort: 5432 }));
      console.log(JSON.stringify({ serve, ms: performance.now() - started }));`,
      directory.path,
    );

    // Assert: the spawn failure ends the wait at once.
    assert.equal(
      result.serve.message,
      'Docker is required for container-backed tests',
      JSON.stringify(result.serve),
    );
    assert.equal(result.serve.cause?.name, 'ConnectionFailedError');
    assert.equal(result.serve.cause?.cause, 'spawn ssh ENOENT');
    assert.ok(result.ms < 5000, `serve took ${result.ms} ms`);
  },
);

test(
  'an ssh that never opens its socket fails serve at the readiness limit and is stopped',
  { skip, timeout: 60_000 },
  async () => {
    // Arrange: ssh stays up but never binds the forward.
    await using directory = await standIns('silent');

    // Act
    const { result } = await scenario(
      directory.path,
      `const started = performance.now();
      const serve = await settled(testbed.serve({ Image: 'standin' }, { internalPort: 5432 }));
      console.log(JSON.stringify({ serve, ms: performance.now() - started, sshAlive: sshAlive() }));`,
    );

    // Assert: serve waits out the socket's limit, then gives up on the
    // missing socket, and leaves no ssh behind.
    assert.match(
      result.serve.message ?? '',
      /ENOENT: no such file or directory, stat '.*zukhruf-testing-forward-.*\/s'/,
      JSON.stringify(result.serve),
    );
    assert.ok(result.ms >= 14_000, `serve gave up after ${result.ms} ms`);
    assert.equal(result.sshAlive, false);
  },
);

test(
  'an ssh that stays up after its stdin ends is killed on disconnect, which still resolves',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: ssh does not exit when disconnect ends its stdin, so disconnect falls back to SIGKILL.
    await using directory = await standIns('stubborn');

    // Act
    const { result, stderr } = await scenario(
      directory.path,
      `const server = await testbed.serve({ Image: 'standin' }, { internalPort: 5432 });
      const disconnect = await settled(server.disconnect());
      console.log(JSON.stringify({ disconnect, sshAlive: sshAlive() }));`,
    );

    // Assert: a deliberate close is not a lost forward.
    assert.equal(result.disconnect, 'resolved', JSON.stringify(result));
    assert.equal(result.sshAlive, false);
    assert.equal(stderr, '');
  },
);

test(
  'a disconnect resolves, stops ssh and prints nothing',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange
    await using directory = await standIns('serve');

    // Act
    const { result, stderr } = await scenario(
      directory.path,
      `const server = await testbed.serve({ Image: 'standin' }, { internalPort: 5432 });
      const disconnect = await settled(server.disconnect());
      console.log(JSON.stringify({ disconnect, sshAlive: sshAlive(), stdinEnded: existsSync(directory + '/stdin-ended') }));`,
    );

    // Assert: ssh stopped because disconnect ended its stdin, not by the SIGKILL fallback.
    assert.equal(result.disconnect, 'resolved', JSON.stringify(result));
    assert.equal(result.sshAlive, false);
    assert.equal(result.stdinEnded, true);
    assert.equal(stderr, '');
  },
);

test(
  'an ssh forward ends by itself when the process that opened it is killed',
  { skip, timeout: 30_000 },
  async (t) => {
    // Arrange
    await using directory = await standIns('serve');

    // Act: the process that opened the forward dies without closing it.
    await assert.rejects(
      scenario(
        directory.path,
        `await testbed.serve({ Image: 'standin' }, { internalPort: 5432 });
        process.kill(process.pid, 'SIGKILL');`,
      ),
      { signalName: 'SIGKILL' },
    );

    // Assert: ssh, orphaned, sees its stdin end and exits.
    const pid = Number(await readFile(join(directory.path, 'ssh.pid'), 'utf8'));
    try {
      await t.waitFor(
        () => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }),
        { timeout: 5_000, interval: 20 },
      );
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  },
);
