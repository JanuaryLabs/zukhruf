import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  Docker,
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

/** A started container of alpine:3 with the label of this test run, that sleeps. */
async function startSleeper(docker: Docker, run: string) {
  const container = await docker.containers.create({
    Image: IMAGE,
    Cmd: ['sleep', '300'],
    Labels: { [TEST_LABEL]: run },
  });
  await container.start();
  return container;
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

describe('container.exec()', () => {
  test('stdin reaches the command, and the end of the input ends it: cat gives the input back', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);

      // Act
      const result = await container.exec(
        { Cmd: ['cat'] },
        { stdin: 'hello\n', signal: AbortSignal.timeout(20_000) },
      );

      // Assert
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        output: 'hello\n',
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('stdout and stderr come apart and in the order of the engine in output, and a non-zero exit code is data', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);

      // Act
      const result = await container.exec({
        Cmd: [
          'sh',
          '-c',
          'echo a; sleep 0.2; echo b >&2; sleep 0.2; echo c; exit 3',
        ],
      });

      // Assert
      assert.deepEqual(result, {
        exitCode: 3,
        stdout: 'a\nc\n',
        stderr: 'b\n',
        output: 'a\nb\nc\n',
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a character whose bytes come in two writes, with stderr between them, is one character in stdout and output', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);

      // Act: the two bytes of 'é', with a pause between them.
      const result = await container.exec({
        Cmd: [
          'sh',
          '-c',
          "printf '\\303'; sleep 0.3; echo x >&2; sleep 0.3; printf '\\251'",
        ],
      });

      // Assert
      assert.equal(result.stdout, 'é');
      assert.equal(result.stderr, 'x\n');
      assert.equal(result.output, 'x\né');
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('1 MB of output arrives byte for byte', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      await container.exec({
        Cmd: ['sh', '-c', 'head -c 1048576 /dev/urandom > /tmp/data'],
      });
      const expected = (
        await container.exec({ Cmd: ['sha256sum', '/tmp/data'] })
      ).stdout.split(' ')[0];

      // Act
      const cat = await container.spawn({ Cmd: ['cat', '/tmp/data'] });
      const hash = createHash('sha256');
      let length = 0;
      for await (const { stream, data } of cat) {
        assert.equal(stream, 'stdout');
        hash.update(data);
        length += data.byteLength;
      }

      // Assert
      assert.equal(length, 1_048_576);
      assert.equal(hash.digest('hex'), expected);
      assert.equal(await cat.exitCode, 0);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('with a TTY, each chunk is stdout', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);

      // Act
      const shell = await container.spawn({
        Cmd: ['sh', '-c', 'echo out; echo err >&2'],
        Tty: true,
      });
      const streams = new Set<string>();
      let text = '';
      for await (const { stream, data } of shell) {
        streams.add(stream);
        text += new TextDecoder().decode(data);
      }

      // Assert
      assert.deepEqual([...streams], ['stdout']);
      assert.match(text, /out/);
      assert.match(text, /err/);
      assert.equal(await shell.exitCode, 0);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a signal cancels the wait of exec() with its reason, and the command still runs to its end', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      const controller = new AbortController();
      const reason = new Error('the caller stopped waiting');

      // Act
      const executing = container.exec(
        { Cmd: ['sh', '-c', 'echo started; sleep 2; touch /tmp/done'] },
        { signal: controller.signal },
      );
      await setTimeout(500);
      controller.abort(reason);

      // Assert
      await assert.rejects(executing, (error: unknown) => error === reason);
      await setTimeout(3000);
      const done = await container.exec({ Cmd: ['test', '-f', '/tmp/done'] });
      assert.equal(done.exitCode, 0);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('exec() of a stopped container is a ContainerNotRunningError with the state exited, and of a paused one with the state paused', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const stopped = await startSleeper(docker, run);
      await stopped.stop({ t: 0 });
      const paused = await startSleeper(docker, run);
      await paused.pause();

      // Act
      const [onStopped, onPaused] = await Promise.allSettled([
        stopped.exec({ Cmd: ['true'] }),
        paused.exec({ Cmd: ['true'] }),
      ]);

      // Assert
      assert.equal(onStopped.status, 'rejected');
      await assert.rejects(
        Promise.reject(onStopped.reason),
        (error: unknown) => {
          assert.ok(error instanceof ContainerNotRunningError);
          assert.equal(error.container, stopped.id);
          assert.equal(error.state, 'exited');
          assert.equal(error.status, 409);
          return true;
        },
      );
      assert.equal(onPaused.status, 'rejected');
      await assert.rejects(
        Promise.reject(onPaused.reason),
        (error: unknown) => {
          assert.ok(error instanceof ContainerNotRunningError);
          assert.equal(error.container, paused.id);
          assert.equal(error.state, 'paused');
          return true;
        },
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('exec() of a removed container is a ContainerNotFoundError with its ID', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      await container.remove({ force: true });

      // Act
      const executing = container.exec({ Cmd: ['true'] });

      // Assert
      await assert.rejects(executing, (error: unknown) => {
        assert.ok(error instanceof ContainerNotFoundError);
        assert.equal(error.container, container.id);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });
});

describe('container.spawn()', () => {
  test('an empty write does not end the input, and close() ends it', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      const cat = await container.spawn({ Cmd: ['cat'] }, { stdin: true });
      assert.ok(cat.stdin);
      const input = cat.stdin.getWriter();
      const collecting = cat.collect();

      // Act
      await input.write(new Uint8Array(0));
      await setTimeout(300);
      const afterEmptyWrite = await Promise.race([
        collecting.then(() => 'ended'),
        setTimeout(0, 'running'),
      ]);
      await input.write(new TextEncoder().encode('hi\n'));
      await input.close();
      const result = await collecting;

      // Assert
      assert.equal(afterEmptyWrite, 'running');
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: 'hi\n',
        stderr: '',
        output: 'hi\n',
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a command that writes faster than the caller reads waits for the caller', async () => {
    // Arrange: the command writes 1000 blocks of 64 KB and records each block in a file.
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      const writer = await container.spawn({
        Cmd: [
          'sh',
          '-c',
          'i=0; while [ $i -lt 1000 ]; do head -c 65536 /dev/zero; i=$((i+1)); echo $i > /tmp/progress; done',
        ],
      });
      const chunks = writer[Symbol.asyncIterator]();

      // Act
      await chunks.next();
      await setTimeout(1000);
      const progress = await container.exec({ Cmd: ['cat', '/tmp/progress'] });
      await chunks.return?.();

      // Assert
      assert.equal(progress.exitCode, 0, progress.stderr);
      const written = Number(progress.stdout.trim());
      assert.ok(written >= 1 && written < 200, `${written} blocks written`);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a second iteration of a container process rejects', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      const echo = await container.spawn({ Cmd: ['echo', 'once'] });
      let first = '';
      for await (const { data } of echo)
        first += new TextDecoder().decode(data);

      // Act
      const again = (async () => {
        for await (const _chunk of echo) assert.fail('a chunk came twice');
      })();

      // Assert
      assert.equal(first, 'once\n');
      await assert.rejects(again, /once/);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('an iteration that ends early and an exit code that no one reads cause no unhandled rejection', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const container = await startSleeper(docker, run);
      const shell = await container.spawn({
        Cmd: ['sh', '-c', 'echo first; sleep 300'],
      });

      // Act
      for await (const _chunk of shell) break;
      await setTimeout(500);

      // Assert
      assert.deepEqual(unhandled, []);
      await assert.rejects(shell.exitCode);
    } finally {
      process.off('unhandledRejection', record);
      await removeLabeled(docker, run);
    }
  });

  test('an abort of the signal rejects the iteration with its reason', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const container = await startSleeper(docker, run);
      const controller = new AbortController();
      const reason = new Error('the caller stopped reading');
      const shell = await container.spawn(
        { Cmd: ['sh', '-c', 'echo first; sleep 300'] },
        { signal: controller.signal },
      );
      const chunks = shell[Symbol.asyncIterator]();
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
