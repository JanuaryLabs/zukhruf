import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DockerTestbed, forLogMessage } from './index.ts';

const image = 'alpine:latest';

test('logs that end before the line reject with how many of the lines came', async (t) => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: ['sh', '-c', 'echo ready; echo done'],
  });
  await container.wait({ condition: 'not-running', signal: t.signal });

  // Act, Assert
  await assert.rejects(
    forLogMessage('ready', { times: 2 })({ container }, t.signal),
    /1 of 2 lines/,
  );
});

test('a line of more than 16 KiB that the engine sends as two frames, with a line of stderr between them, matches', async (t) => {
  // Arrange: the log driver sends the first 16 KiB of a line that has no end
  // yet as a partial message, so "rea" ends one frame and "dy" starts another.
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: [
      'sh',
      '-c',
      "head -c 16381 /dev/zero | tr '\\0' a; printf rea; sleep 0.3; echo x >&2; sleep 0.3; echo dy",
    ],
  });
  await container.wait({ condition: 'not-running', signal: t.signal });

  // Act, Assert
  await forLogMessage('ready')({ container }, t.signal);
});

test('a character of UTF-8 that two frames split, with a line of stderr between them, matches', async (t) => {
  // Arrange: 16 383 bytes and the first byte of "é" fill the 16 KiB of the
  // first frame, and its second byte starts the frame after the line of stderr.
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: [
      'sh',
      '-c',
      "head -c 16383 /dev/zero | tr '\\0' a; printf '\\303'; sleep 0.3; echo x >&2; sleep 0.3; printf '\\251 ready\\n'",
    ],
  });
  await container.wait({ condition: 'not-running', signal: t.signal });

  // Act, Assert
  await forLogMessage('é ready')({ container }, t.signal);
});

test('the lines of an earlier run of a restarted container do not count', async (t) => {
  // Arrange: the first run prints the line, and the second run does not.
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: [
      'sh',
      '-c',
      'if [ -f /started ]; then echo again; else touch /started; echo ready; fi',
    ],
  });
  await container.wait({ condition: 'not-running', signal: t.signal });
  await container.start();
  await container.wait({ condition: 'not-running', signal: t.signal });

  // Act, Assert
  await assert.rejects(
    forLogMessage('ready')({ container }, t.signal),
    /0 of 1 lines/,
  );
});

test('a line that the container printed before the call counts', async (t) => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: ['sh', '-c', 'echo ready'],
  });
  await container.wait({ condition: 'not-running', signal: t.signal });

  // Act, Assert
  await forLogMessage('ready')({ container }, t.signal);
});

test('times counts the lines that match a RegExp, also one with the g flag', async (t) => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: [
      'sh',
      '-c',
      'echo "API listen on /var/run/docker.sock"; echo "API listen on [::]:2375"',
    ],
  });
  await container.wait({ condition: 'not-running', signal: t.signal });

  // Act, Assert
  await forLogMessage(/API listen on/g, { times: 2 })({ container }, t.signal);
});

test('a line that comes after the call ends the wait while the container runs', async (t) => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: ['sh', '-c', 'sleep 1; echo ready; sleep 60'],
  });

  // Act
  await forLogMessage('ready')({ container }, t.signal);

  // Assert
  assert.equal((await container.inspect()).State?.Running, true);
});

test('an abort of the signal while the wait follows the logs rejects the wait with its reason', async () => {
  // Arrange: the target delegates to the real container, and the abort comes
  // when the wait opens the logs, after its inspect.
  const testbed = new DockerTestbed({ environment: process.env });
  await using container = await testbed.start({
    Image: image,
    Cmd: ['sleep', '60'],
  });
  const controller = new AbortController();
  const reason = new Error('the startup time limit');
  const following = new Proxy(container, {
    get(real, key) {
      const value: unknown = Reflect.get(real, key, real);
      if (key === 'followLogs')
        return (options: Parameters<typeof container.followLogs>[0]) => {
          const logs = real.followLogs(options);
          controller.abort(reason);
          return logs;
        };
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });

  // Act, Assert
  await assert.rejects(
    forLogMessage('ready')({ container: following }, controller.signal),
    (error) => error === reason,
  );
});
