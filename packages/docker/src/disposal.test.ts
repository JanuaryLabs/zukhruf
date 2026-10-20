import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { delimiter } from 'node:path';
import { describe, test } from 'node:test';

import { Docker, DockerError } from './index.ts';
import { ENTRY, lastJson, runScenario } from './testing/scenario.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';
import {
  isAlive,
  localEngineSocket,
  sshStandIn,
} from './testing/ssh-stand-in.ts';

const TEST_LABEL = 'dev.zukhruf.docker.test';
const IMAGE = 'alpine:3';
const DISPOSED = /client was disposed/;

const posixOnly =
  process.platform === 'win32'
    ? 'the ssh stand-in is a POSIX executable with a shebang'
    : false;
const engineSocket = posixOnly ? undefined : await localEngineSocket();
const needsLocalEngine =
  posixOnly ||
  (engineSocket === undefined
    ? 'the current context of config.json is not a local unix:// engine'
    : false);

/** Removes each container with the label of this test run. */
async function removeLabeled(docker: Docker, run: string): Promise<void> {
  const left = await docker.containers.list({
    all: true,
    filters: { label: [`${TEST_LABEL}=${run}`] },
  });
  for (const summary of left) {
    const container = await docker.containers.find(summary.Id);
    await container?.remove({ force: true, v: true });
  }
}

/**
 * A scenario that connects with `connect`, starts a labeled container that
 * writes one line and sleeps, reads the first chunk of followLogs() and
 * of a spawn of `sleep`, disposes the client, and prints how each iteration
 * ended. It does not remove the container.
 */
const disposeWhileIterating = (connect: string, run: string) => `
import { Docker, DockerError } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect(${connect});
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
    await using cleaner = await Docker.connect({ environment: process.env });
    if (!(await cleaner.images.inspect(IMAGE)))
      await cleaner.images.pull(IMAGE);
    const run = randomUUID();
    try {
      const docker = await Docker.connect({ environment: process.env });
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
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      const host = `unix://${String(engineSocket)}`;
      await using cleaner = await Docker.connect({ host });
      if (!(await cleaner.images.inspect(IMAGE))) {
        await cleaner.images.pull(IMAGE);
      }
      const run = randomUUID();
      try {
        // Act
        const result = await runScenario(
          disposeWhileIterating(JSON.stringify({ host }), run),
          { HOME: home.path },
          AbortSignal.timeout(30_000),
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
    'through ssh, the iterations reject, each ssh process ends, and the process exits by itself',
    { skip: needsLocalEngine },
    async () => {
      // Arrange
      await using home = await scratchDirectory();
      await using standIn = await sshStandIn({
        kind: 'engine',
        socketPath: String(engineSocket),
      });
      await using cleaner = await Docker.connect({
        host: `unix://${String(engineSocket)}`,
      });
      if (!(await cleaner.images.inspect(IMAGE))) {
        await cleaner.images.pull(IMAGE);
      }
      const run = randomUUID();
      try {
        // Act
        const result = await runScenario(
          disposeWhileIterating(
            JSON.stringify({ host: 'ssh://tester@machine' }),
            run,
          ),
          {
            PATH: `${standIn.path}${delimiter}${process.env.PATH}`,
            HOME: home.path,
          },
          AbortSignal.timeout(30_000),
        );

        // Assert
        assert.equal(result.exitCode, 0, result.stderr);
        const [logs, exec] = Object(lastJson(result));
        assert.match(String(logs), DISPOSED);
        assert.match(String(exec), DISPOSED);
        const runs = await standIn.runs();
        assert.ok(
          runs.length >= 2,
          'the followed logs and the exec each hold a connection',
        );
        assert.deepEqual(
          runs.map(({ pid }) => pid).filter(isAlive),
          [],
          'each ssh process ended',
        );
      } finally {
        for (const { pid } of await standIn.runs()) {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
        await removeLabeled(cleaner, run);
      }
    },
  );
});
