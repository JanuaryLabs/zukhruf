import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { Docker } from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';

/** A frame of standard output of a multiplexed stream. */
function stdoutFrame(data: string | Uint8Array): Buffer {
  const payload = Buffer.from(data);
  const header = Buffer.alloc(8);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, payload]);
}

/**
 * An engine that writes the output of an attach or an exec only after the
 * client ends its input, as socktainer does. The container c1 is created by
 * run(); its exec e1 ends with exit code 3, and its wait with exit code 7.
 */
async function waitsForTheEndOfTheInput(directory: string, output: Buffer) {
  const waiting = Promise.withResolvers<ServerResponse>();
  return fakeEngine({
    directory,
    apiVersion: '1.51',
    highWaterMark: 64 * 1024,
    hijack: (_request, socket: Duplex) => {
      socket.once('end', () => {
        socket.end(stdoutFrame(output));
        void waiting.promise.then((wait) =>
          wait.end(JSON.stringify({ StatusCode: 7 })),
        );
      });
      socket.resume();
    },
    answer: (request, response) => {
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const path = new URL(request.url ?? '', 'http://engine').pathname;
      const route = `${request.method} ${path}`;
      if (route === 'POST /v1.51/containers/create') {
        json(201, { Id: 'c1', Warnings: [] });
      } else if (route === 'GET /v1.51/containers/c1/json') {
        json(200, { Id: 'c1', State: { Status: 'created' } });
      } else if (route === 'POST /v1.51/containers/c1/wait') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        waiting.resolve(response);
      } else if (
        route === 'POST /v1.51/containers/c1/start' ||
        route === 'DELETE /v1.51/containers/c1'
      ) {
        response.writeHead(204);
        response.end();
      } else if (route === 'POST /v1.51/containers/c1/exec') {
        json(201, { Id: 'e1' });
      } else if (route === 'GET /v1.51/exec/e1/json') {
        json(200, { Running: false, ExitCode: 3 });
      } else {
        json(404, { message: 'page not found' });
      }
    },
  });
}

describe('the end of the input of an attach and an exec without stdin', () => {
  test('containers.run() ends the input of its attach at once, and all of the output that the engine sends after the end of the input arrives', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const output = Buffer.alloc(1024 * 1024, 0x62);
    await using engine = await waitsForTheEndOfTheInput(scratch.path, output);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });

    // Act
    const result = await docker.containers.run({
      Image: 'alpine',
      Cmd: ['sh', '-c', 'head -c 1048576 /dev/zero | tr "\\0" b'],
    });

    // Assert
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, output.toString());
    assert.equal(result.stderr, '');
  });

  test('exec() without stdin ends its input at once, and all of the output that the engine sends after the end of the input arrives', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('docker-test-');
    const output = Buffer.alloc(1024 * 1024, 0x62);
    await using engine = await waitsForTheEndOfTheInput(scratch.path, output);
    await using docker = await Docker.connect({
      clock: globalThis,
      host: engine.host,
    });
    const container = await docker.containers.find('c1');
    assert.ok(container);

    // Act
    const result = await container.exec({ Cmd: ['true'] });

    // Assert
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, output.toString());
    assert.equal(result.stderr, '');
  });
});
