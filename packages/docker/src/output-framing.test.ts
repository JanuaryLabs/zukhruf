import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Docker } from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

/** A frame of a multiplexed stream: 1 is standard output, 2 standard error. */
function frame(marker: 1 | 2, data: string): Buffer {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(8);
  header.writeUInt8(marker, 0);
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

/** The output of `sh -c "echo out; echo err >&2"` as frames. */
const FRAMES = Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')]);

/**
 * An engine with the running container c1, whose Config.Tty is `tty`, and its
 * exec e1, which ended with exit code 0. Each attach, exec start and logs
 * answer writes FRAMES and ends. With no `contentType` the answers have no
 * Content-Type, as socktainer's do.
 */
async function standIn(directory: string, tty: boolean, contentType?: string) {
  const header =
    contentType === undefined ? '' : `Content-Type: ${contentType}\r\n`;
  return fakeEngine({
    directory,
    apiVersion: '1.51',
    upgradeHead: `HTTP/1.1 101 Switching Protocols\r\n${header}Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
    hijack: (_request, socket) => {
      socket.end(FRAMES);
    },
    answer: (request, response) => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const path = new URL(request.url ?? '', 'http://engine').pathname;
      const route = `${request.method} ${path}`;
      if (route === 'GET /v1.51/containers/c1/json') {
        json(200, {
          Id: 'c1',
          State: { Status: 'running' },
          Config: { Tty: tty },
        });
      } else if (route === 'POST /v1.51/containers/c1/exec') {
        json(201, { Id: 'e1' });
      } else if (route === 'GET /v1.51/exec/e1/json') {
        json(200, { Running: false, ExitCode: 0 });
      } else if (route === 'POST /v1.51/containers/c1/wait') {
        json(200, { StatusCode: 0 });
      } else if (route === 'GET /v1.51/containers/c1/logs') {
        response.writeHead(
          200,
          contentType === undefined ? {} : { 'Content-Type': contentType },
        );
        response.end(FRAMES);
      } else {
        json(404, { message: 'page not found' });
      }
    },
  });
}

describe('the output of an engine that sends no Content-Type, as socktainer', () => {
  test('an exec without a TTY gives stdout and stderr apart', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path, false);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const result = await container.exec({
      Cmd: ['sh', '-c', 'echo out; echo err >&2'],
    });

    // Assert
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: 'out\n',
      stderr: 'err\n',
      output: 'out\nerr\n',
    });
  });

  test('an exec with a TTY gives each byte as stdout, even bytes that look like a frame', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path, false);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const result = await container.exec({ Cmd: ['sh'], Tty: true });

    // Assert
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: FRAMES.toString(),
      stderr: '',
      output: FRAMES.toString(),
    });
  });

  test('an attach to a container without a TTY gives stdout and stderr apart', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path, false);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const result = await (await container.attach()).collect();

    // Assert
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: 'out\n',
      stderr: 'err\n',
      output: 'out\nerr\n',
    });
  });

  test('an attach to a container with a TTY gives each byte as stdout', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path, true);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const result = await (await container.attach()).collect();

    // Assert
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: FRAMES.toString(),
      stderr: '',
      output: FRAMES.toString(),
    });
  });

  test('the logs of a container without a TTY give stdout and stderr apart', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path, false);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const logs = await container.logs();

    // Assert
    assert.deepEqual(logs, {
      stdout: 'out\n',
      stderr: 'err\n',
      output: 'out\nerr\n',
    });
  });

  test('the logs of a container with a TTY give each byte as stdout', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(scratch.path, true);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const logs = await container.logs();

    // Assert
    assert.deepEqual(logs, {
      stdout: FRAMES.toString(),
      stderr: '',
      output: FRAMES.toString(),
    });
  });
});

describe('the Content-Type of the output', () => {
  test('an exec with a TTY gives each byte as stdout when the engine names a multiplexed stream', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(
      scratch.path,
      false,
      'application/vnd.docker.multiplexed-stream',
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const result = await container.exec({ Cmd: ['sh'], Tty: true });

    // Assert
    assert.equal(result.stdout, FRAMES.toString());
    assert.equal(result.stderr, '');
  });

  test('the logs of a container without a TTY give stdout and stderr apart when the engine names a raw stream', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await standIn(
      scratch.path,
      false,
      'application/vnd.docker.raw-stream',
    );
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const logs = await container.logs();

    // Assert
    assert.deepEqual(logs, {
      stdout: 'out\n',
      stderr: 'err\n',
      output: 'out\nerr\n',
    });
  });
});
