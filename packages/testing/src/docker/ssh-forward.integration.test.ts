import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import spawn from 'nano-spawn';

const skip =
  process.platform === 'win32'
    ? 'the docker and ssh stand-ins are POSIX executables'
    : false;

/**
 * Stands in for the Docker CLI of an ssh:// engine: it answers what serve()
 * and cleanup() ask, and `docker rm` fails while `rm-fails` exists.
 */
const dockerStandIn = (directory: string) => `#!/bin/sh
case "$1" in
  context) echo 'ssh://tester@sshhost' ;;
  info) ;;
  run) echo standin-container ;;
  port) echo 127.0.0.1:49999 ;;
  stop) ;;
  rm)
    if [ -e '${directory}/rm-fails' ]; then
      echo 'Error response from daemon: removal of container standin-container is already in progress' >&2
      exit 1
    fi ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac
`;

/**
 * Stands in for OpenSSH's `ssh -N -L <socket>:127.0.0.1:<port>`. `ssh-mode`
 * picks its behavior: `serve` opens the socket, `refused` fails to connect,
 * `silent` never opens the socket, `stubborn` ignores SIGTERM. A `lose` file
 * ends the forward the way a dead connection does. Messages are OpenSSH's.
 */
const sshStandIn = `#!${process.execPath}
const { createServer } = require('node:net');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
writeFileSync(join(__dirname, 'ssh.pid'), String(process.pid));
const mode = readFileSync(join(__dirname, 'ssh-mode'), 'utf8').trim();
if (mode === 'refused') {
  process.stderr.write('ssh: connect to host sshhost port 22: Connection refused\\n');
  process.exit(255);
}
// An ssh -N session exits 0 on SIGTERM (OpenSSH clientloop.c).
process.on('SIGTERM', () => { if (mode !== 'stubborn') process.exit(0); });
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
`;

/** A directory holding the stand-ins, with ssh started in `mode`. */
async function standIns(mode: string, { withSsh = true } = {}) {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-testing-ssh-'),
  );
  await writeFile(
    join(directory.path, 'docker'),
    dockerStandIn(directory.path),
    {
      mode: 0o755,
    },
  );
  if (withSsh)
    await writeFile(join(directory.path, 'ssh'), sshStandIn, { mode: 0o755 });
  await writeFile(join(directory.path, 'ssh-mode'), mode);
  return directory;
}

/**
 * Runs `body` in a new Node process whose PATH starts with the stand-ins, so
 * its Docker resolves the ssh:// engine. `body` prints one JSON line.
 */
async function scenario(directory: string, body: string, path?: string) {
  const source = `
    import { connect } from 'node:net';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    import { Docker } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const directory = ${JSON.stringify(directory)};
    const failure = (error) => ({
      message: error.message,
      cause: error.cause && { message: error.cause.message, exitCode: error.cause.exitCode, code: error.cause.code },
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
    { env: { PATH: path ?? `${directory}:${process.env.PATH}` } },
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
      const server = await new Docker().serve({ image: 'standin', internalPort: 5432 });
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
    await using directory = await standIns('serve');
    await writeFile(join(directory.path, 'rm-fails'), '');

    // Act
    const { result } = await scenario(
      directory.path,
      `
      const server = await new Docker().serve({ image: 'standin', internalPort: 5432 });
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
      messages.some((message) =>
        /^Command failed with exit code 1: docker rm .*standin-container$/.test(
          message,
        ),
      ),
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
        serve: await settled(new Docker().serve({ image: 'standin', internalPort: 5432 })),
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
  'a machine without ssh fails serve at once, naming the missing command',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: PATH holds only the docker stand-in.
    await using directory = await standIns('serve', { withSsh: false });

    // Act
    const { result } = await scenario(
      directory.path,
      `const started = performance.now();
      const serve = await settled(new Docker().serve({ image: 'standin', internalPort: 5432 }));
      console.log(JSON.stringify({ serve, ms: performance.now() - started }));`,
      directory.path,
    );

    // Assert: the spawn failure ends the wait at once, not at the readiness limit.
    assert.match(
      `${result.serve.message} ${result.serve.cause?.code}`,
      /ENOENT/,
      JSON.stringify(result.serve),
    );
    assert.match(result.serve.message, /\bssh\b/);
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
      const serve = await settled(new Docker().serve({ image: 'standin', internalPort: 5432 }));
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
  'an ssh that ignores SIGTERM is killed on disconnect, which still resolves',
  { skip, timeout: 30_000 },
  async () => {
    // Arrange: ssh does not stop on SIGTERM, so disconnect falls back to SIGKILL.
    await using directory = await standIns('stubborn');

    // Act
    const { result, stderr } = await scenario(
      directory.path,
      `const server = await new Docker().serve({ image: 'standin', internalPort: 5432 });
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
      `const server = await new Docker().serve({ image: 'standin', internalPort: 5432 });
      const disconnect = await settled(server.disconnect());
      console.log(JSON.stringify({ disconnect, sshAlive: sshAlive() }));`,
    );

    // Assert
    assert.equal(result.disconnect, 'resolved', JSON.stringify(result));
    assert.equal(result.sshAlive, false);
    assert.equal(stderr, '');
  },
);
