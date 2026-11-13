import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { type Duplex, getDefaultHighWaterMark } from 'node:stream';
import { describe, test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';

import { Docker, IncompleteOutputError } from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

const HIGH_WATER_MARK = getDefaultHighWaterMark(false);

const linuxOnly =
  process.platform === 'linux'
    ? false
    : 'only Linux resets the read of a Unix socket; macOS gives the end';

/** A frame of standard output of a multiplexed stream. */
function stdoutFrame(data: string | Uint8Array): Buffer {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

/**
 * An engine with the running container c1 and its exec e1, which ended with
 * exit code 3. It gives the socket of the attach or of the exec start, and
 * the answer of the wait of an attach, which the test ends.
 */
async function standIn(directory: string) {
  const hijacked = Promise.withResolvers<Duplex>();
  const waiting = Promise.withResolvers<ServerResponse>();
  const engine = await fakeEngine({
    directory,
    apiVersion: '1.51',
    hijack: (_request, socket) => hijacked.resolve(socket),
    answer: (request, response) => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const path = new URL(request.url ?? '', 'http://engine').pathname;
      const route = `${request.method} ${path}`;
      if (route === 'GET /v1.51/containers/c1/json') {
        json(200, { Id: 'c1', State: { Status: 'running' } });
      } else if (route === 'POST /v1.51/containers/c1/exec') {
        json(201, { Id: 'e1' });
      } else if (route === 'GET /v1.51/exec/e1/json') {
        json(200, { Running: false, ExitCode: 3 });
      } else if (route === 'POST /v1.51/containers/c1/wait') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        waiting.resolve(response);
      } else {
        json(404, { message: 'page not found' });
      }
    },
  });
  return {
    host: engine.host,
    socket: hijacked.promise,
    wait: waiting.promise,
    [Symbol.asyncDispose]: () => engine[Symbol.asyncDispose](),
  };
}

/**
 * Leaves input unread in the kernel of the stand-in, whose socket reads at
 * most one chunk of 64 KB after the upgrade. The write resolves when the
 * kernel took all of it, which a Linux socket buffer can hold.
 */
async function leaveInputUnread(
  stdin: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  await stdin.write(new Uint8Array(128 * 1024).fill(0x61));
}

/**
 * Writes `total` bytes of output in frames of 16 KB, each one after the last
 * one reached the kernel, and counts the bytes that reached it.
 */
function writeOutput(socket: Duplex, total: number) {
  const done = Promise.withResolvers<void>();
  const sent = { bytes: 0 };
  const next = () => {
    if (sent.bytes >= total) return done.resolve();
    const size = Math.min(16 * 1024, total - sent.bytes);
    socket.write(stdoutFrame(new Uint8Array(size).fill(0x62)), (error) => {
      if (error) return;
      sent.bytes += size;
      next();
    });
  };
  next();
  return { sent, done: done.promise };
}

/**
 * Resolves when the client took at least the high-water mark of Node and then
 * no byte of the output reached the kernel for 20 turns of the event loop: the
 * client stopped reading.
 */
async function untilTheClientStopsReading(sent: {
  bytes: number;
}): Promise<void> {
  for (let still = 0, last = -1; still < 20;) {
    await setImmediate();
    still = sent.bytes === last && last >= HIGH_WATER_MARK ? still + 1 : 0;
    last = sent.bytes;
  }
}

describe('the end of the output of an exec and an attach', () => {
  test(
    'a reset after some output is the end of the output: the container process of an exec gives the output and the exit code',
    {
      skip: linuxOnly,
    },
    async () => {
      // Arrange
      await using scratch = await scratchDirectory();
      await using engine = await standIn(scratch.path);
      await using docker = await Docker.connect({
        clock: globalThis,
        host: engine.host,
      });
      const container = await docker.containers.find('c1');
      assert.ok(container);
      const process = await container.spawn({ Cmd: ['cat'] }, { stdin: true });
      assert.ok(process.stdin);
      const socket = await engine.socket;
      await leaveInputUnread(process.stdin.getWriter());

      // Act
      socket.write(stdoutFrame('out'), () => socket.destroy());
      const result = await process.collect();

      // Assert
      assert.deepEqual(result, {
        exitCode: 3,
        stdout: 'out',
        stderr: '',
        output: 'out',
      });
    },
  );

  test(
    'a reader slower than the connection gets each byte that came before a reset',
    {
      skip: linuxOnly,
    },
    async () => {
      // Arrange
      await using scratch = await scratchDirectory();
      await using engine = await standIn(scratch.path);
      await using docker = await Docker.connect({
        clock: globalThis,
        host: engine.host,
      });
      const container = await docker.containers.find('c1');
      assert.ok(container);
      const process = await container.spawn({ Cmd: ['cat'] }, { stdin: true });
      assert.ok(process.stdin);
      const socket = await engine.socket;
      await leaveInputUnread(process.stdin.getWriter());
      const total = 1024 * 1024;

      // Act
      const output = writeOutput(socket, total);
      void output.done.then(() => socket.destroy());
      let received = 0;
      for await (const chunk of process) {
        received += chunk.data.byteLength;
        await setTimeout(2);
      }

      // Assert
      assert.equal(received, total);
      assert.equal(await process.exitCode, 3);
    },
  );

  test(
    'an attach gives the output that came before a reset, and the exit code of the wait',
    {
      skip: linuxOnly,
    },
    async () => {
      // Arrange
      await using scratch = await scratchDirectory();
      await using engine = await standIn(scratch.path);
      await using docker = await Docker.connect({
        clock: globalThis,
        host: engine.host,
      });
      const container = await docker.containers.find('c1');
      assert.ok(container);
      const process = await container.attach({ stdin: true });
      assert.ok(process.stdin);
      const socket = await engine.socket;
      const wait = await engine.wait;
      await leaveInputUnread(process.stdin.getWriter());

      // Act
      socket.once('close', () => wait.end(JSON.stringify({ StatusCode: 3 })));
      socket.write(stdoutFrame('out'), () => socket.destroy());
      const result = await process.collect();

      // Assert
      assert.deepEqual(result, {
        exitCode: 3,
        stdout: 'out',
        stderr: '',
        output: 'out',
      });
    },
  );

  test('a stdin write that fails before any output came is an IncompleteOutputError with the exit code and the write error', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path);
    void engine.socket.then((socket) => socket.destroy());
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const executing = container.exec(
      { Cmd: ['cat'] },
      { stdin: new Uint8Array(1024).fill(0x61) },
    );

    // Assert
    await assert.rejects(executing, (error: unknown) => {
      assert.ok(error instanceof IncompleteOutputError, String(error));
      assert.equal(error.exitCode, 3);
      assert.equal(Reflect.get(Object(error.cause), 'code'), 'EPIPE');
      return true;
    });
  });

  test('a stdin write that fails while the caller has not taken the output is an IncompleteOutputError', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);
    const process = await container.spawn({ Cmd: ['cat'] }, { stdin: true });
    assert.ok(process.stdin);
    const stdin = process.stdin.getWriter();
    const socket = await engine.socket;
    const output = writeOutput(socket, 4 * 1024 * 1024);
    await untilTheClientStopsReading(output.sent);

    // Act
    socket.destroy();
    await assert.rejects(stdin.write(Uint8Array.of(0x61)), { code: 'EPIPE' });
    const collecting = process.collect();

    // Assert
    await assert.rejects(collecting, (error: unknown) => {
      assert.ok(error instanceof IncompleteOutputError, String(error));
      assert.equal(error.exitCode, 3);
      assert.equal(Reflect.get(Object(error.cause), 'code'), 'EPIPE');
      return true;
    });
    assert.equal(await process.exitCode, 3);
  });

  test('a stdin write that fails after the caller took the output is not an error: the output ends, with the exit code', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);
    const process = await container.spawn({ Cmd: ['cat'] }, { stdin: true });
    assert.ok(process.stdin);
    const stdin = process.stdin.getWriter();
    const socket = await engine.socket;
    const chunks = process[Symbol.asyncIterator]();
    socket.write(stdoutFrame('out'));
    const first = await chunks.next();

    // Act
    socket.destroy();
    const writeFailed = assert.rejects(stdin.write(Uint8Array.of(0x61)), {
      code: 'EPIPE',
    });
    const rest = await chunks.next();

    // Assert
    await writeFailed;
    assert.deepEqual(first, {
      done: false,
      value: { stream: 'stdout', data: Buffer.from('out') },
    });
    assert.deepEqual(rest, { done: true, value: undefined });
    assert.equal(await process.exitCode, 3);
  });

  test('a caller that does not take the output stops the reads, and the reads go on when it takes the output', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);
    const process = await container.spawn({ Cmd: ['cat'] });
    const socket = await engine.socket;
    const total = 4 * 1024 * 1024;
    const output = writeOutput(socket, total);

    // Act
    await untilTheClientStopsReading(output.sent);
    const sentWhileNotTaken = output.sent.bytes;
    void output.done.then(() => socket.end());
    const result = await process.collect();

    // Assert
    assert.ok(
      sentWhileNotTaken < 4 * HIGH_WATER_MARK,
      `${sentWhileNotTaken} bytes reached the client before it took any`,
    );
    assert.equal(result.stdout.length, total);
    assert.equal(result.exitCode, 3);
  });
});
