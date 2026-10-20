import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  ContainerNotRunningError,
  Docker,
  NetworkNotFoundError,
} from './index.ts';

const TEST_LABEL = 'dev.zukhruf.docker.test';
const IMAGE = 'alpine:3';

/** The engine that the environment of the test run selects, with alpine:3 on it. */
async function connect(): Promise<Docker> {
  const docker = await Docker.connect({
    environment: process.env,
    signal: AbortSignal.timeout(15_000),
  });
  if (!(await docker.images.inspect(IMAGE))) await docker.images.pull(IMAGE);
  return docker;
}

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

/** The IDs of the containers with the label of this test run. */
async function labeledIds(docker: Docker, run: string): Promise<string[]> {
  const listed = await docker.containers.list({
    all: true,
    filters: { label: [`${TEST_LABEL}=${run}`] },
  });
  return listed.map((summary) => summary.Id);
}

describe('container.attach()', () => {
  test('an attach before start() gets all output and the exit code', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sh', '-c', 'echo one; sleep 0.2; echo two >&2; exit 5'],
        Labels: { [TEST_LABEL]: run },
      });

      // Act
      const attached = await container.attach();
      await container.start();
      const result = await attached.collect();

      // Assert
      assert.deepEqual(result, {
        exitCode: 5,
        stdout: 'one\n',
        stderr: 'two\n',
        output: 'one\ntwo\n',
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('an attach to a running container gets the output from then on and the exit code when it stops', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sh', '-c', 'echo early; sleep 5; echo late; exit 4'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.start();
      for await (const _early of container.followLogs({
        signal: AbortSignal.timeout(20_000),
      })) {
        break;
      }

      // Act
      const attached = await container.attach();
      const result = await attached.collect();

      // Assert
      assert.deepEqual(result, {
        exitCode: 4,
        stdout: 'late\n',
        stderr: '',
        output: 'late\n',
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('stdin of an attach reaches the main process, and close() ends its input', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['cat'],
        OpenStdin: true,
        StdinOnce: true,
        Labels: { [TEST_LABEL]: run },
      });
      const attached = await container.attach({ stdin: true });
      await container.start();
      assert.ok(attached.stdin);
      const input = attached.stdin.getWriter();

      // Act
      await input.write(new TextEncoder().encode('in\n'));
      await input.close();
      const result = await attached.collect();

      // Assert
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: 'in\n',
        stderr: '',
        output: 'in\n',
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('an attach to an exited container is a ContainerNotRunningError with the state exited, and to a paused one with the state paused', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const exited = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['true'],
        Labels: { [TEST_LABEL]: run },
      });
      await exited.start();
      await exited.wait({ condition: 'not-running' });
      const paused = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await paused.start();
      await paused.pause();

      // Act
      const [toExited, toPaused] = await Promise.allSettled([
        exited.attach({ signal: AbortSignal.timeout(20_000) }),
        paused.attach({ signal: AbortSignal.timeout(20_000) }),
      ]);

      // Assert
      assert.equal(toExited.status, 'rejected');
      await assert.rejects(
        Promise.reject(toExited.reason),
        (error: unknown) => {
          assert.ok(error instanceof ContainerNotRunningError);
          assert.equal(error.container, exited.id);
          assert.equal(error.state, 'exited');
          return true;
        },
      );
      assert.equal(toPaused.status, 'rejected');
      await assert.rejects(
        Promise.reject(toPaused.reason),
        (error: unknown) => {
          assert.ok(error instanceof ContainerNotRunningError);
          assert.equal(error.state, 'paused');
          return true;
        },
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('containers.run()', () => {
  test('run() gives the output and a non-zero exit code, keeps the labels and removes its container', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const since = Math.floor(Date.now() / 1000) - 1;
    try {
      // Act
      const result = await docker.containers.run({
        Image: IMAGE,
        Cmd: ['sh', '-c', 'echo out; sleep 0.2; echo err >&2; exit 2'],
        Labels: { [TEST_LABEL]: run },
      });

      // Assert
      assert.deepEqual(result, {
        exitCode: 2,
        stdout: 'out\n',
        stderr: 'err\n',
        output: 'out\nerr\n',
      });
      const actions: string[] = [];
      for await (const event of docker.events({
        since,
        filters: { type: ['container'], label: [`${TEST_LABEL}=${run}`] },
        signal: AbortSignal.timeout(20_000),
      })) {
        actions.push(event.Action ?? '');
        if (event.Action === 'destroy') break;
      }
      assert.ok(actions.includes('create'), actions.join());
      assert.ok(actions.includes('start'), actions.join());
      assert.equal(actions.at(-1), 'destroy');
      assert.deepEqual(await labeledIds(docker, run), []);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('with a TTY, run() gives standard error in stdout', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      // Act
      const result = await docker.containers.run({
        Image: IMAGE,
        Cmd: ['sh', '-c', 'echo err >&2'],
        Tty: true,
        Labels: { [TEST_LABEL]: run },
      });

      // Assert
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /err/);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a cancel while the container runs rejects with the reason and removes the container', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const controller = new AbortController();
    const reason = new Error('the caller stopped waiting');
    const since = Math.floor(Date.now() / 1000) - 1;
    try {
      const running = docker.containers.run(
        {
          Image: IMAGE,
          Cmd: ['sleep', '300'],
          Labels: { [TEST_LABEL]: run },
        },
        { signal: controller.signal },
      );
      running.catch(() => undefined);
      for await (const _started of docker.events({
        since,
        filters: { label: [`${TEST_LABEL}=${run}`], event: ['start'] },
        signal: AbortSignal.timeout(20_000),
      })) {
        break;
      }

      // Act
      controller.abort(reason);

      // Assert
      await assert.rejects(running, (error: unknown) => error === reason);
      assert.deepEqual(await labeledIds(docker, run), []);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a start that fails rejects with its error and removes the container', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const network = `zukhruf-missing-${run}`;
    try {
      // Act
      const running = docker.containers.run({
        Image: IMAGE,
        Cmd: ['true'],
        Labels: { [TEST_LABEL]: run },
        HostConfig: { NetworkMode: network },
      });

      // Assert
      await assert.rejects(running, NetworkNotFoundError);
      assert.deepEqual(await labeledIds(docker, run), []);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});
