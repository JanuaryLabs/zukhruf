import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  ConnectionFailedError,
  Docker,
  DockerEngineError,
  DockerError,
  UnsupportedEngineError,
} from './index.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { ENTRY, runScenario } from './testing/scenario.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

describe('Docker.connect() refuses an engine it cannot use', () => {
  test('a socket that does not exist is a ConnectionFailedError', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const host = `unix://${join(scratch.path, 'absent.sock')}`;

    // Act
    const connecting = Docker.connect({ host });

    // Assert
    await assert.rejects(connecting, (error: unknown) => {
      assert.ok(error instanceof ConnectionFailedError);
      assert.ok(error instanceof DockerError);
      assert.equal(error.host, host);
      assert.equal(Reflect.get(Object(error.cause), 'code'), 'ENOENT');
      return true;
    });
  });

  test('a socket file that a killed engine left behind is a ConnectionFailedError', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const socketPath = join(scratch.path, 'stale.sock');
    const listener = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { createServer } from 'node:net';
createServer().listen(${JSON.stringify(socketPath)}, () => console.log('listening'));`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    try {
      await new Promise<void>((resolve) =>
        listener.stdout.once('data', () => resolve()),
      );
      const exited = new Promise((resolve) => listener.once('exit', resolve));
      listener.kill('SIGKILL');
      await exited;

      // Act
      const connecting = Docker.connect({ host: `unix://${socketPath}` });

      // Assert
      await assert.rejects(connecting, (error: unknown) => {
        assert.ok(error instanceof ConnectionFailedError);
        assert.equal(error.host, `unix://${socketPath}`);
        assert.equal(Reflect.get(Object(error.cause), 'code'), 'ECONNREFUSED');
        return true;
      });
    } finally {
      listener.kill('SIGKILL');
    }
  });

  test('an engine with an API version below 1.44 is an UnsupportedEngineError', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.20',
    });

    // Act
    const connecting = Docker.connect({ host: engine.host });

    // Assert
    await assert.rejects(connecting, (error: unknown) => {
      assert.ok(error instanceof UnsupportedEngineError);
      assert.ok(error instanceof DockerError);
      assert.equal(error.host, engine.host);
      assert.equal(error.engineVersion, '1.20');
      assert.equal(error.minimumVersion, '1.44');
      return true;
    });
  });

  test('a signal aborts a ping that the engine never answers, with the reason of the signal', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      silentPing: true,
    });
    const controller = new AbortController();
    const reason = new Error('the caller gave up');

    // Act
    const connecting = Docker.connect({
      host: engine.host,
      signal: controller.signal,
    });
    await waitUntil(() => engine.paths.includes('/_ping'));
    controller.abort(reason);

    // Assert
    await assert.rejects(connecting, (error: unknown) => error === reason);
  });
});

describe('Docker.connect() negotiates the API version', () => {
  test('an engine above the highest version gets the highest version, compared by number', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using higher = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'higher'),
      apiVersion: '1.99',
    });
    await using longer = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'longer'),
      apiVersion: '1.100',
      answer: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      },
    });

    // Act
    await using docker = await Docker.connect({ host: higher.host });
    await using other = await Docker.connect({ host: longer.host });
    await other.info();

    // Assert
    assert.equal(docker.apiVersion, '1.56');
    assert.equal(other.apiVersion, '1.56');
    assert.deepEqual(longer.paths, ['/_ping', '/v1.56/info']);
  });

  test('an engine between the lowest and the highest version gets its own version in each path', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.50',
      answer: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ServerVersion: '28.3.0' }));
      },
    });

    // Act
    await using docker = await Docker.connect({ host: engine.host });
    const info = await docker.info();

    // Assert
    assert.equal(docker.apiVersion, '1.50');
    assert.equal(info.ServerVersion, '28.3.0');
    assert.deepEqual(engine.paths, ['/_ping', '/v1.50/info']);
    assert.deepEqual(docker.cliEnvironment, {
      DOCKER_HOST: engine.host,
      DOCKER_CONTEXT: undefined,
    });
  });
});

describe('a request that the engine answers with an error', () => {
  test('is a DockerEngineError with the status, the method, the path and the message of the engine', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (_request, response) => {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ message: 'the daemon is shutting down' }),
        );
      },
    });
    await using docker = await Docker.connect({ host: engine.host });

    // Act
    const info = docker.info();

    // Assert
    await assert.rejects(info, (error: unknown) => {
      assert.ok(error instanceof DockerEngineError);
      assert.ok(error instanceof DockerError);
      assert.equal(error.status, 500);
      assert.deepEqual(error.request, { method: 'GET', path: '/info' });
      assert.equal(error.message, 'the daemon is shutting down');
      return true;
    });
  });
});

describe('the connections of a client', () => {
  test(
    'disposal closes each connection to the engine',
    { timeout: 10_000 },
    async () => {
      // Arrange
      await using scratch = await scratchDirectory();
      await using engine = await fakeEngine({
        directory: scratch.path,
        apiVersion: '1.51',
        answer: (_request, response) => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{}');
        },
      });
      const docker = await Docker.connect({ host: engine.host });
      await docker.info();
      assert.ok(engine.openConnections > 0, 'the idle connection stays open');

      // Act
      await docker[Symbol.asyncDispose]();

      // Assert
      await engine.allConnectionsClosed;
      assert.equal(engine.openConnections, 0);
    },
  );

  test('a process that connects and never disposes the client still exits by itself', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using engine = await fakeEngine({
      directory: scratch.path,
      apiVersion: '1.51',
      answer: (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      },
    });
    const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect({ host: ${JSON.stringify(engine.host)} });
await docker.info();
console.log('connected');
`;

    // Act
    const result = await runScenario(
      scenario,
      { HOME: scratch.path },
      AbortSignal.timeout(15_000),
    );

    // Assert
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'connected');
    assert.deepEqual(engine.paths, ['/_ping', '/v1.51/info']);
  });
});

async function mkdirIn(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path);
  return path;
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('The condition never held.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
