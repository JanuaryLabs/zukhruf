import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { type ConnectOptions, Docker } from './index.ts';
import { writeContextStore } from './testing/context-store-files.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { ENTRY, lastJson, runScenario } from './testing/scenario.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

const platformHost =
  process.platform === 'win32'
    ? 'npipe:////./pipe/docker_engine'
    : 'unix:///var/run/docker.sock';

/** Connects with the options and gives the context and host of the client, or the error. */
async function selected(options: ConnectOptions): Promise<object> {
  try {
    await using docker = await Docker.connect(options);
    return { context: docker.context, host: docker.host };
  } catch (error) {
    const name: unknown = Reflect.get(Object(error), 'name');
    const host: unknown = Reflect.get(Object(error), 'host');
    const context: unknown = Reflect.get(Object(error), 'context');
    return { error: name, host, context };
  }
}

/** In a child process, connects with `options` (source text) and prints the context and host of the client. */
const connectScenario = (options: string) => `
import { Docker } from ${JSON.stringify(ENTRY)};
const docker = await Docker.connect(${options});
console.log(JSON.stringify({ context: docker.context, host: docker.host }));
await docker[Symbol.asyncDispose]();
`;

describe('Docker.connect() selects the engine in the order of the Docker CLI', () => {
  test('DOCKER_HOST wins over DOCKER_CONTEXT and currentContext', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });
    await using fromVariable = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'variable'),
      apiVersion: '1.51',
    });
    await using fromConfig = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'config'),
      apiVersion: '1.51',
    });
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, {
      currentContext: 'from-config',
      contexts: {
        'from-variable': fromVariable.host,
        'from-config': fromConfig.host,
      },
    });

    // Act
    const result = await selected({
      environment: {
        DOCKER_CONFIG: config,
        DOCKER_HOST: fromHost.host,
        DOCKER_CONTEXT: 'from-variable',
      },
    });

    // Assert
    assert.deepEqual(result, { context: 'default', host: fromHost.host });
    assert.deepEqual(fromHost.paths, ['/_ping']);
  });

  test('DOCKER_CONTEXT wins over currentContext', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromVariable = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'variable'),
      apiVersion: '1.51',
    });
    await using fromConfig = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'config'),
      apiVersion: '1.51',
    });
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, {
      currentContext: 'from-config',
      contexts: {
        'from-variable': fromVariable.host,
        'from-config': fromConfig.host,
      },
    });

    // Act
    const result = await selected({
      environment: { DOCKER_CONFIG: config, DOCKER_CONTEXT: 'from-variable' },
    });

    // Assert
    assert.deepEqual(result, {
      context: 'from-variable',
      host: fromVariable.host,
    });
  });

  test('currentContext of config.json selects the engine when no variable is set', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromConfig = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'config'),
      apiVersion: '1.51',
    });
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, {
      currentContext: 'from-config',
      contexts: { 'from-config': fromConfig.host },
    });

    // Act
    const result = await selected({ environment: { DOCKER_CONFIG: config } });

    // Assert
    assert.deepEqual(result, { context: 'from-config', host: fromConfig.host });
  });

  test('~/.docker is the configuration directory when DOCKER_CONFIG is not set', async () => {
    // Arrange: a child process, because HOME is the home directory of the process.
    await using scratch = await scratchDirectory();
    await using fromConfig = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'config'),
      apiVersion: '1.51',
    });
    await writeContextStore(join(scratch.path, '.docker'), {
      currentContext: 'from-home',
      contexts: { 'from-home': fromConfig.host },
    });

    // Act
    const result = await runScenario(
      connectScenario('{ environment: process.env }'),
      { HOME: scratch.path },
    );

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'from-home',
      host: fromConfig.host,
    });
  });

  test('without an environment, no variable applies and only the context store selects the engine', async () => {
    // Arrange: a child process, because the variables must be in the environment of the process.
    await using scratch = await scratchDirectory();
    await using fromConfig = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'config'),
      apiVersion: '1.51',
    });
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });
    await writeContextStore(join(scratch.path, '.docker'), {
      currentContext: 'from-home',
      contexts: { 'from-home': fromConfig.host, other: fromHost.host },
    });

    // Act
    const result = await runScenario(connectScenario(''), {
      HOME: scratch.path,
      DOCKER_HOST: fromHost.host,
      DOCKER_CONTEXT: 'other',
      DOCKER_CONFIG: join(scratch.path, 'absent'),
    });

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'from-home',
      host: fromConfig.host,
    });
    assert.deepEqual(fromHost.paths, []);
  });

  test('the default context and the default host of the platform when nothing selects an engine', async () => {
    // Arrange
    await using scratch = await scratchDirectory();

    // Act
    const result = await selected({
      environment: { DOCKER_CONFIG: join(scratch.path, 'absent') },
    });

    // Assert
    // The machine may or may not run an engine on the default host.
    assert.ok(
      isDeepEqual(result, { context: 'default', host: platformHost }) ||
        isDeepEqual(result, {
          error: 'ConnectionFailedError',
          host: platformHost,
          context: undefined,
        }),
      JSON.stringify(result),
    );
  });

  test('a context option ignores DOCKER_HOST and DOCKER_CONTEXT', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using named = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'named'),
      apiVersion: '1.51',
    });
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, {
      contexts: { named: named.host, other: fromHost.host },
    });

    // Act
    const result = await selected({
      context: 'named',
      environment: {
        DOCKER_CONFIG: config,
        DOCKER_HOST: fromHost.host,
        DOCKER_CONTEXT: 'other',
      },
    });

    // Assert
    assert.deepEqual(result, { context: 'named', host: named.host });
    assert.deepEqual(fromHost.paths, []);
  });

  test('the context option default takes its host from DOCKER_HOST, as in the Docker CLI', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });

    // Act
    const result = await selected({
      context: 'default',
      environment: {
        DOCKER_CONFIG: join(scratch.path, 'absent'),
        DOCKER_HOST: fromHost.host,
      },
    });

    // Assert
    assert.deepEqual(result, { context: 'default', host: fromHost.host });
    assert.deepEqual(fromHost.paths, ['/_ping']);
  });

  test('a host option ignores the environment', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using given = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'given'),
      apiVersion: '1.51',
    });
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, { contexts: { other: fromHost.host } });

    // Act
    const result = await selected({
      host: given.host,
      environment: {
        DOCKER_CONFIG: config,
        DOCKER_HOST: fromHost.host,
        DOCKER_CONTEXT: 'other',
      },
    });

    // Assert
    assert.deepEqual(result, { context: 'default', host: given.host });
    assert.deepEqual(fromHost.paths, []);
  });

  test('a context that the context store does not have is a ContextNotFoundError, from the option or from DOCKER_CONTEXT', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, { contexts: {} });

    // Act
    const fromOption = await selected({
      context: 'absent',
      environment: { DOCKER_CONFIG: config },
    });
    const fromVariable = await selected({
      environment: { DOCKER_CONFIG: config, DOCKER_CONTEXT: 'absent' },
    });

    // Assert
    const expected = {
      error: 'ContextNotFoundError',
      host: undefined,
      context: 'absent',
    };
    assert.deepEqual(fromOption, expected);
    assert.deepEqual(fromVariable, expected);
  });

  test('a tcp:// host is an UnsupportedHostError, from the option, from DOCKER_HOST or from a context', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const config = join(scratch.path, 'docker-config');
    const fromOption = 'tcp://127.0.0.1:2375';
    const fromVariable = 'tcp://127.0.0.1:2376';
    const fromContext = 'tcp://127.0.0.1:2377';
    await writeContextStore(config, {
      currentContext: 'remote',
      contexts: { remote: fromContext },
    });
    const environment = { DOCKER_CONFIG: config };

    // Act
    const results = [
      await selected({ host: fromOption, environment }),
      await selected({
        environment: { ...environment, DOCKER_HOST: fromVariable },
      }),
      await selected({ environment }),
    ];

    // Assert
    assert.deepEqual(
      results,
      [fromOption, fromVariable, fromContext].map((host) => ({
        error: 'UnsupportedHostError',
        host,
        context: undefined,
      })),
    );
  });

  test('an empty DOCKER_HOST or DOCKER_CONTEXT is the same as an unset one', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromConfig = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'config'),
      apiVersion: '1.51',
    });
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, {
      currentContext: 'from-config',
      contexts: { 'from-config': fromConfig.host },
    });

    // Act
    const result = await selected({
      environment: {
        DOCKER_CONFIG: config,
        DOCKER_HOST: '',
        DOCKER_CONTEXT: '',
      },
    });

    // Assert
    assert.deepEqual(result, { context: 'from-config', host: fromConfig.host });
  });
});

describe('Docker.contexts()', () => {
  test('lists the default context and each stored context, and marks the current one', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, {
      currentContext: 'desktop-linux',
      contexts: {
        'desktop-linux': 'unix:///Users/me/.docker/run/docker.sock',
        'remote-box': 'ssh://root@remote.example',
      },
    });

    // Act
    const fromConfig = await Docker.contexts({
      environment: { DOCKER_CONFIG: config },
    });
    const fromVariable = await Docker.contexts({
      environment: { DOCKER_CONFIG: config, DOCKER_CONTEXT: 'remote-box' },
    });
    const fromHost = await Docker.contexts({
      environment: {
        DOCKER_CONFIG: config,
        DOCKER_HOST: 'unix:///tmp/other.sock',
      },
    });

    // Assert
    assert.deepEqual(fromConfig, [
      { name: 'default', host: platformHost, current: false },
      {
        name: 'desktop-linux',
        host: 'unix:///Users/me/.docker/run/docker.sock',
        current: true,
      },
      {
        name: 'remote-box',
        host: 'ssh://root@remote.example',
        current: false,
      },
    ]);
    assert.deepEqual(
      fromVariable.filter(({ current }) => current).map(({ name }) => name),
      ['remote-box'],
      'DOCKER_CONTEXT makes its context current',
    );
    assert.deepEqual(
      fromHost,
      [
        { name: 'default', host: 'unix:///tmp/other.sock', current: true },
        {
          name: 'desktop-linux',
          host: 'unix:///Users/me/.docker/run/docker.sock',
          current: false,
        },
        {
          name: 'remote-box',
          host: 'ssh://root@remote.example',
          current: false,
        },
      ],
      'DOCKER_HOST makes the default context current, with that host',
    );
  });

  test('gives the same host for the default context as connect() with the same environment', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });
    const environment = {
      DOCKER_CONFIG: join(scratch.path, 'absent'),
      DOCKER_HOST: fromHost.host,
    };

    // Act
    const contexts = await Docker.contexts({ environment });
    const named = await selected({ context: 'default', environment });
    const current = await selected({ environment });

    // Assert
    assert.deepEqual(contexts, [
      { name: 'default', host: fromHost.host, current: true },
    ]);
    assert.deepEqual(named, { context: 'default', host: fromHost.host });
    assert.deepEqual(current, { context: 'default', host: fromHost.host });
  });

  test('gives only the default context when the configuration directory does not exist', async () => {
    // Arrange
    await using scratch = await scratchDirectory();

    // Act
    const result = await Docker.contexts({
      environment: { DOCKER_CONFIG: join(scratch.path, 'absent') },
    });

    // Assert
    assert.deepEqual(result, [
      { name: 'default', host: platformHost, current: true },
    ]);
  });
});

async function mkdirIn(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path);
  return path;
}

function isDeepEqual(actual: unknown, expected: unknown): boolean {
  try {
    assert.deepEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}
