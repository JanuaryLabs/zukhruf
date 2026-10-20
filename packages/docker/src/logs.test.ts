import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { Docker } from './index.ts';

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

/** A container of alpine:3 with the label of this test run that runs `script` and exits. */
async function startScript(
  docker: Docker,
  run: string,
  script: string,
  tty = false,
) {
  const container = await docker.containers.create({
    Image: IMAGE,
    Cmd: ['sh', '-c', script],
    Tty: tty,
    Labels: { [TEST_LABEL]: run },
  });
  await container.start();
  return container;
}

describe('container.logs()', () => {
  test('logs() gives stdout, stderr and output in the order of the engine, and takes tail, since and timestamps', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startScript(
        docker,
        run,
        'echo a; sleep 0.2; echo b >&2; sleep 0.2; echo c',
      );
      await container.wait({ condition: 'not-running' });

      // Act
      const all = await container.logs();
      const last = await container.logs({ tail: 1 });
      const future = await container.logs({
        since: Math.floor(Date.now() / 1000) + 3600,
      });
      const stamped = await container.logs({ timestamps: true });

      // Assert
      assert.deepEqual(all, {
        stdout: 'a\nc\n',
        stderr: 'b\n',
        output: 'a\nb\nc\n',
      });
      assert.equal(last.output, 'c\n');
      assert.equal(future.output, '');
      assert.match(
        stamped.stdout,
        /^\d{4}-\d\d-\d\dT\S+Z a\n\d{4}-\d\d-\d\dT\S+Z c\n$/,
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('the logs of a container with a TTY are all stdout', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startScript(docker, run, 'echo err >&2', true);
      await container.wait({ condition: 'not-running' });

      // Act
      const logs = await container.logs();

      // Assert
      assert.equal(logs.stderr, '');
      assert.match(logs.stdout, /err/);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('container.followLogs()', () => {
  test('the iteration gives the chunks as the container writes them and ends when the container stops', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startScript(
        docker,
        run,
        'echo first; sleep 1; echo second >&2',
      );

      // Act
      const chunks: { stream: string; text: string }[] = [];
      for await (const { stream, data } of container.followLogs({
        signal: AbortSignal.timeout(20_000),
      })) {
        chunks.push({ stream, text: new TextDecoder().decode(data) });
      }

      // Assert
      assert.deepEqual(chunks, [
        { stream: 'stdout', text: 'first\n' },
        { stream: 'stderr', text: 'second\n' },
      ]);
      assert.equal((await container.inspect()).State?.Status, 'exited');
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('an abort of the signal rejects the iteration with its reason', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startScript(docker, run, 'echo first; sleep 300');
      const controller = new AbortController();
      const reason = new Error('the caller stopped reading');
      const logs = container.followLogs({ signal: controller.signal });
      const chunks = logs[Symbol.asyncIterator]();
      await chunks.next();

      // Act
      controller.abort(reason);
      const next = chunks.next();

      // Assert
      await assert.rejects(next, (error: unknown) => error === reason);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('docker.events()', () => {
  test('the events give the start of a container that a filter selects, and an abort rejects the iteration with its reason', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const controller = new AbortController();
    const reason = new Error('the caller stopped reading');
    try {
      // since: the events from one second before, so a start that comes
      // before the request of the events reaches the engine still counts.
      const stream = docker.events({
        since: Math.floor(Date.now() / 1000) - 1,
        filters: { label: [`${TEST_LABEL}=${run}`], event: ['start'] },
        signal: controller.signal,
      });
      const events = stream[Symbol.asyncIterator]();
      const container = await startScript(docker, run, 'sleep 300');

      // Act
      const started = await events.next();
      controller.abort(reason);
      const next = events.next();

      // Assert
      assert.equal(started.done, false);
      assert.equal(started.value?.Action, 'start');
      assert.equal(started.value?.Actor?.ID, container.id);
      assert.equal(started.value?.Actor?.Attributes?.[TEST_LABEL], run);
      await assert.rejects(next, (error: unknown) => error === reason);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});
