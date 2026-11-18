import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { poll } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';

import { ConnectionFailedError, Docker, DockerError } from './index.ts';
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
import { fakeEngine } from './testing/fake-engine.ts';
import { localEngineSocket } from './testing/local-engine.ts';
import {
  ENTRY,
  inheritedEnvironment,
  lastJson,
  runScenario,
} from './testing/scenario.ts';

const DISPOSED = /client was disposed/;

const engineSocket = await localEngineSocket(process.env);
const needsLocalEngine =
  engineSocket === undefined
    ? 'the current context of config.json is not a local unix:// engine'
    : false;
const sshEngine = await engineForSshd();

/**
 * A scenario that connects with `connect`, starts a labeled container that
 * writes one line and sleeps, reads the first chunk of followLogs() and
 * of a spawn of `sleep`, disposes the client, and prints how each iteration
 * ended. It does not remove the container.
 */
const disposeWhileIterating = (connect: string, run: string) => `
import { Docker, DockerError } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({ ...${connect}, environment: process.env, clock: globalThis });
const container = await docker.containers.create({
  Image: ${JSON.stringify(IMAGE)},
  Cmd: ['sh', '-c', 'echo up; sleep 300'],
  Labels: { ${JSON.stringify(TEST_LABEL)}: ${JSON.stringify(run)} },
});
await container.start();
const logs = container.followLogs()[Symbol.asyncIterator]();
await logs.next();
const sleeper = await container.spawn({ Cmd: ['sh', '-c', 'echo up; sleep 300'] });
const exec = sleeper[Symbol.asyncIterator]();
await exec.next();
const ended = (iterator) => iterator.next().then(
  ({ done }) => 'resolved, done: ' + done,
  (error) => (error instanceof DockerError ? error.message : 'other: ' + error),
);
const pending = [ended(logs), ended(exec)];
await docker[Symbol.asyncDispose]();
console.log(JSON.stringify(await Promise.all(pending)));
`;

describe('disposal of a client with open streams', () => {
  test('an open followLogs() and an open spawn() iteration reject with a DockerError that says that the client was disposed', async () => {
    // Arrange
    await using cleaner = await Docker.connect({
      clock: globalThis,
      environment: process.env,
    });
    if (!(await cleaner.images.inspect(IMAGE)))
      await cleaner.images.pull(IMAGE);
    const run = randomUUID();
    try {
      const docker = await Docker.connect({
        clock: globalThis,
        environment: process.env,
      });
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sh', '-c', 'echo up; sleep 300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.start();
      const logs = container.followLogs()[Symbol.asyncIterator]();
      await logs.next();
      const sleeper = await container.spawn({
        Cmd: ['sh', '-c', 'echo up; sleep 300'],
      });
      const exec = sleeper[Symbol.asyncIterator]();
      await exec.next();
      const pending = [logs.next(), exec.next()];
      for (const each of pending) each.catch(() => undefined);

      // Act
      await docker[Symbol.asyncDispose]();

      // Assert
      for (const each of pending) {
        await assert.rejects(each, (error) => {
          assert.ok(error instanceof DockerError);
          assert.match(error.message, DISPOSED);
          return true;
        });
      }
    } finally {
      await removeLabeled(cleaner, run);
    }
  });

  test(
    'through a Unix socket, the iterations reject and the process exits by itself',
    { skip: needsLocalEngine },
    async (t) => {
      // Arrange
      await using home = await new TemporaryFiles().directory('docker-test-');
      const host = `unix://${String(engineSocket)}`;
      await using cleaner = await Docker.connect({ clock: globalThis, host });
      if (!(await cleaner.images.inspect(IMAGE))) {
        await cleaner.images.pull(IMAGE);
      }
      const run = randomUUID();
      try {
        // Act
        const result = await runScenario(
          disposeWhileIterating(JSON.stringify({ host }), run),
          { HOME: home.path },
          t.signal,
        );

        // Assert
        assert.equal(result.exitCode, 0, result.stderr);
        const [logs, exec] = Object(lastJson(result));
        assert.match(String(logs), DISPOSED);
        assert.match(String(exec), DISPOSED);
      } finally {
        await removeLabeled(cleaner, run);
      }
    },
  );

  test(
    'through ssh, the iterations reject, the SSH connection ends, and the process exits by itself',
    { skip: skipWithout(sshEngine) },
    async (t) => {
      // Arrange
      await using sshd = await startEngineSshd(
        engineVariables(ready(sshEngine)),
      );
      const sshFlags = await clientFlags(sshd);
      await using cleaner = await Docker.connect({
        clock: globalThis,
        host: `unix://${ready(sshEngine).engineSocket}`,
      });
      if (!(await cleaner.images.inspect(IMAGE))) {
        await cleaner.images.pull(IMAGE);
      }
      const run = randomUUID();
      try {
        // Act
        const result = await runScenario(
          disposeWhileIterating(
            JSON.stringify({ host: SSH_HOST, sshFlags }),
            run,
          ),
          inheritedEnvironment(),
          t.signal,
        );

        // Assert
        assert.equal(result.exitCode, 0, result.stderr);
        const [logs, exec] = Object(lastJson(result));
        assert.match(String(logs), DISPOSED);
        assert.match(String(exec), DISPOSED);
        await sshd.connectionsEnded({ signal: t.signal });
      } finally {
        await removeLabeled(cleaner, run);
      }
    },
  );
});

describe('requests during and after disposal', () => {
  test('through a Unix socket, a request in flight and a request after disposal started reject with the DockerError of disposal, and the second one reaches no engine', async (t) => {
    // Arrange: the engine never answers /info.
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: () => undefined,
    });
    const docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const inFlight = docker.info();
    inFlight.catch(() => undefined);
    await poll(
      async () => (engine.paths.includes('/v1.51/info') ? true : undefined),
      { signal: t.signal, clock: globalThis, interval: 10 },
    );

    // Act
    const disposing = docker[Symbol.asyncDispose]();
    const late = docker.info();
    late.catch(() => undefined);
    await disposing;

    // Assert
    for (const each of [inFlight, late]) {
      await assert.rejects(each, (error) => {
        assert.ok(error instanceof DockerError);
        assert.equal(error instanceof ConnectionFailedError, false);
        assert.match(error.message, DISPOSED);
        return true;
      });
    }
    assert.equal(
      engine.paths.filter((path) => path === '/v1.51/info').length,
      1,
    );
  });

  test(
    'through ssh, a request in flight and a request after disposal started reject with the DockerError of disposal, the second one reaches no engine, and the SSH connection ends',
    { skip: skipWithout(sshEngine) },
    async (t) => {
      // Arrange: the engine never answers /info.
      await using scratch = await new TemporaryFiles().directory(
        'docker-test-',
      );
      const seen = Promise.withResolvers<void>();
      await using engine = await fakeEngine({
        directory: scratch.path,
        apiVersion: '1.51',
        answer: () => seen.resolve(),
      });
      await using sshd = await startEngineSshd({
        ...engineVariables(ready(sshEngine)),
        DOCKER_HOST: engine.host,
      });
      const docker = await Docker.connect({
        clock: globalThis,
        environment: process.env,
        host: SSH_HOST,
        sshFlags: await clientFlags(sshd),
        signal: t.signal,
      });
      const inFlight = docker.info();
      inFlight.catch(() => undefined);
      await seen.promise;

      // Act
      const disposing = docker[Symbol.asyncDispose]();
      const late = docker.info();
      late.catch(() => undefined);
      await disposing;

      // Assert
      for (const each of [inFlight, late]) {
        await assert.rejects(each, (error) => {
          assert.ok(error instanceof DockerError);
          assert.equal(error instanceof ConnectionFailedError, false);
          assert.match(error.message, DISPOSED);
          return true;
        });
      }
      assert.equal(
        engine.paths.filter((path) => path === '/v1.51/info').length,
        1,
      );
      await sshd.connectionsEnded({ signal: t.signal });
    },
  );
});
