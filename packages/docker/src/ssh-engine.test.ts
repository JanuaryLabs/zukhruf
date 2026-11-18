import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { untilAborted } from '@zukhruf/async';
import { AuthenticationError, OpenChannelError } from '@zukhruf/ssh';
import { KeyError } from '@zukhruf/ssh/knownhosts';

import { ConnectionFailedError, Docker } from './index.ts';
import {
  SSH_HOST,
  clientFlags,
  engineForSshd,
  engineVariables,
  ready,
  skipWithout,
  startEngineSshd,
} from './testing/engine-sshd.ts';
import { IMAGE, TEST_LABEL, removeLabeled } from './testing/engine.ts';
import {
  ENTRY,
  inheritedEnvironment,
  lastJson,
  runScenario,
} from './testing/scenario.ts';

const run = promisify(execFile);
const engine = await engineForSshd();
const skip = skipWithout(engine);

/** A TCP server on 127.0.0.1 that accepts each connection and never writes: no SSH banner comes. */
async function startSilentServer() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => sockets.add(socket));
  const accepted = once(server, 'connection');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    port: address.port,
    accepted,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

/** Whether `promise` settled before the next turn of the event loop. */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await nextMacrotask();
  return settled;
}

/** The engine behind sshd, through its socket, with IMAGE on it. */
async function localEngine(signal: AbortSignal): Promise<Docker> {
  const docker = await Docker.connect({
    clock: globalThis,
    host: `unix://${ready(engine).engineSocket}`,
    signal,
  });
  if (!(await docker.images.inspect(IMAGE, { signal }))) {
    await docker.images.pull(IMAGE, { signal });
  }
  return docker;
}

describe('the SSH connection of an ssh:// host', () => {
  test(
    'without the environment option, connect() rejects with a ConnectionFailedError that says an ssh:// engine needs it, before any SSH connection',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      await using silent = await startSilentServer();
      const sshFlags = await clientFlags(sshd, { port: silent.port });

      // Act
      const connected = Docker.connect({
        clock: globalThis,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });
      const first = await Promise.race([
        connected.then(
          () => 'connected',
          (error: unknown) => error,
        ),
        silent.accepted.then(() => 'an SSH connection'),
      ]);

      // Assert
      assert.ok(first instanceof ConnectionFailedError, String(first));
      assert.equal(first.host, SSH_HOST);
      for (const part of [
        'needs the `environment` option',
        'SSH_AUTH_SOCK',
        'HOME',
        '`process.env`',
      ]) {
        assert.ok(first.message.includes(part), `${part}: ${first.message}`);
      }
    },
  );

  test(
    'without ConnectTimeout in sshFlags, connect() to a server that never answers rejects with a ConnectionFailedError once 30 s pass on the clock of the client, and not before',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      await using silent = await startSilentServer();
      const sshFlags = await clientFlags(sshd, { port: silent.port });
      const clock = createClock();
      const connected = Docker.connect({
        clock,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });
      connected.catch(() => undefined);
      await silent.accepted;

      // Act
      clock.tick(29_999);
      const settledBefore = await settledNow(connected);
      clock.tick(1);
      const settledAt = await settledNow(connected);

      // Assert
      assert.deepEqual(
        { settledBefore, settledAt },
        {
          settledBefore: false,
          settledAt: true,
        },
      );
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, SSH_HOST);
        assert.ok(error.cause instanceof DOMException);
        assert.equal(error.cause.name, 'TimeoutError');
        return true;
      });
    },
  );

  test(
    'a ConnectTimeout in sshFlags is the limit of the connection in place of 30 s',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      await using silent = await startSilentServer();
      const sshFlags = [
        ...(await clientFlags(sshd, { port: silent.port })),
        '-o',
        'ConnectTimeout=5',
      ];
      const clock = createClock();
      const connected = Docker.connect({
        clock,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });
      connected.catch(() => undefined);
      await silent.accepted;

      // Act
      clock.tick(4999);
      const settledBefore = await settledNow(connected);
      clock.tick(1);
      const settledAt = await settledNow(connected);

      // Assert
      assert.deepEqual(
        { settledBefore, settledAt },
        {
          settledBefore: false,
          settledAt: true,
        },
      );
      await assert.rejects(connected, ConnectionFailedError);
    },
  );

  test(
    'a user key that sshd refuses rejects connect() with a ConnectionFailedError whose cause is the AuthenticationError of @zukhruf/ssh',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      const refused = join(sshd.directory, 'refused_ed25519');
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', refused]);
      const sshFlags = await clientFlags(sshd, { identityFile: refused });

      // Act
      const connected = Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, SSH_HOST);
        assert.ok(error.cause instanceof AuthenticationError, String(error));
        return true;
      });
    },
  );

  test(
    'a host key that the known hosts file does not have rejects connect() with a ConnectionFailedError whose cause is the KeyError of @zukhruf/ssh',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      const sshFlags = await clientFlags(sshd, { knownHosts: '' });

      // Act
      const connected = Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, SSH_HOST);
        assert.ok(error.cause instanceof KeyError, String(error));
        assert.deepEqual(error.cause.want, []);
        return true;
      });
    },
  );
});

describe('the engine socket of an ssh:// host', () => {
  test(
    'when the Docker CLI on the SSH server selects an engine that is not unix://, connect() rejects with a ConnectionFailedError that names that engine, and the SSH connection ends',
    { skip },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd({
        ...engineVariables(ready(engine)),
        DOCKER_HOST: 'tcp://127.0.0.1:2375',
      });
      const sshFlags = await clientFlags(sshd);

      // Act
      const connected = Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, SSH_HOST);
        assert.ok(error.message.includes(SSH_HOST), error.message);
        assert.ok(
          error.message.includes('tcp://127.0.0.1:2375'),
          error.message,
        );
        return true;
      });
      await sshd.connectionsEnded({ signal: t.signal });
    },
  );

  test(
    'when docker context inspect fails on the SSH server, connect() rejects with a ConnectionFailedError that gives its standard error, and the SSH connection ends',
    { skip },
    async (t) => {
      // Arrange
      const { PATH } = engineVariables(ready(engine));
      await using sshd = await startEngineSshd({
        PATH,
        DOCKER_CONTEXT: 'no-such-context',
      });
      const sshFlags = await clientFlags(sshd);

      // Act
      const connected = Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, SSH_HOST);
        assert.ok(
          error.message.includes('docker context inspect'),
          error.message,
        );
        assert.ok(
          error.message.includes(
            'context "no-such-context": context not found',
          ),
          error.message,
        );
        return true;
      });
      await sshd.connectionsEnded({ signal: t.signal });
    },
  );

  test(
    'when the SSH server refuses a connection to the engine socket, connect() rejects with a ConnectionFailedError that names the socket, the refusal and the fixes, and the SSH connection ends',
    { skip },
    async (t) => {
      // Arrange
      const { engineSocket } = ready(engine);
      await using sshd = await startEngineSshd(engineVariables(ready(engine)), [
        'AllowStreamLocalForwarding no',
      ]);
      const sshFlags = await clientFlags(sshd);

      // Act
      const connected = Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags,
        signal: t.signal,
      });

      // Assert
      await assert.rejects(connected, (error) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, SSH_HOST);
        for (const part of [
          SSH_HOST,
          engineSocket,
          'refused',
          'rootless Docker',
          '/run/user/<uid>',
          'OpenSSH server',
        ]) {
          assert.ok(error.message.includes(part), `${part}: ${error.message}`);
        }
        assert.ok(error.cause instanceof OpenChannelError, String(error.cause));
        assert.ok(
          error.message.includes(error.cause.description),
          `${error.cause.description}: ${error.message}`,
        );
        return true;
      });
      await sshd.connectionsEnded({ signal: t.signal });
    },
  );
});

describe('the process of a client of an ssh:// host', () => {
  test(
    'an attach in use keeps the process running until its output ends, while the client is otherwise idle',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      const sshFlags = await clientFlags(sshd);
      const label = randomUUID();
      const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({
  clock: globalThis,
  environment: process.env,
  host: ${JSON.stringify(SSH_HOST)},
  sshFlags: ${JSON.stringify(sshFlags)},
});
const container = await docker.containers.create({
  Image: ${JSON.stringify(IMAGE)},
  Cmd: ['sh', '-c', 'sleep 1; echo late'],
  Labels: { ${JSON.stringify(TEST_LABEL)}: ${JSON.stringify(label)} },
});
const attached = await container.attach();
await container.start();
console.log(JSON.stringify(await attached.collect()));
`;
      try {
        // Act
        const result = await runScenario(
          scenario,
          inheritedEnvironment(),
          t.signal,
        );

        // Assert
        assert.equal(result.exitCode, 0, result.stderr);
        assert.deepEqual(lastJson(result), {
          exitCode: 0,
          stdout: 'late\n',
          stderr: '',
          output: 'late\n',
        });
      } finally {
        await removeLabeled(local, label);
      }
    },
  );
});

describe('the input of an exec over an ssh:// host', () => {
  test(
    'a command that does not read all of its input gives its whole result: true and head -c1 with 10 MB of stdin',
    { skip },
    async (t) => {
      // Arrange
      await using local = await localEngine(t.signal);
      await using sshd = await startEngineSshd(engineVariables(ready(engine)));
      await using docker = await Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags: await clientFlags(sshd),
        signal: t.signal,
      });
      const label = randomUUID();
      try {
        const container = await docker.containers.create(
          {
            Image: IMAGE,
            // If the exec hangs, --test-force-exit can end the process
            // before the finally block: the engine then removes the
            // container when it ends by itself.
            Cmd: ['sleep', '600'],
            Labels: { [TEST_LABEL]: label },
            HostConfig: { AutoRemove: true },
          },
          { signal: t.signal },
        );
        await container.start({ signal: t.signal });
        const stdin = new Uint8Array(10 * 1024 * 1024).fill(0x61);

        // Act
        // The bound ends a hang at the limit of the test, so the cleanup runs.
        const results = await untilAborted(
          Promise.all([
            container.exec({ Cmd: ['true'] }, { stdin, signal: t.signal }),
            container.exec(
              { Cmd: ['head', '-c1'] },
              { stdin, signal: t.signal },
            ),
          ]),
          t.signal,
        );

        // Assert
        assert.deepEqual(results, [
          { exitCode: 0, stdout: '', stderr: '', output: '' },
          { exitCode: 0, stdout: 'a', stderr: '', output: 'a' },
        ]);
      } finally {
        await removeLabeled(local, label);
      }
    },
  );
});
