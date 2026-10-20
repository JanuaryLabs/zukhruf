import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { writeContextStore } from './testing/context-store-files.ts';
import { fakeEngine } from './testing/fake-engine.ts';
import { ENTRY, lastJson, runScenario } from './testing/scenario.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

/** Connects with the given options and prints the context and host of the client, or the error. */
const connectScenario = (options: object) => `
import { Docker } from ${JSON.stringify(ENTRY)};
try {
  const docker = await Docker.connect(${JSON.stringify(options)});
  console.log(JSON.stringify({ context: docker.context, host: docker.host }));
  await docker[Symbol.asyncDispose]();
} catch (error) {
  console.log(JSON.stringify({ error: error.name, host: error.host, context: error.context }));
}
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
    const result = await runScenario(connectScenario({}), {
      HOME: scratch.path,
      DOCKER_CONFIG: config,
      DOCKER_HOST: fromHost.host,
      DOCKER_CONTEXT: 'from-variable',
    });

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'default',
      host: fromHost.host,
    });
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
    const result = await runScenario(connectScenario({}), {
      HOME: scratch.path,
      DOCKER_CONFIG: config,
      DOCKER_CONTEXT: 'from-variable',
    });

    // Assert
    assert.deepEqual(lastJson(result), {
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
    const result = await runScenario(connectScenario({}), {
      HOME: scratch.path,
      DOCKER_CONFIG: config,
    });

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'from-config',
      host: fromConfig.host,
    });
  });

  test('~/.docker is the configuration directory when DOCKER_CONFIG is not set', async () => {
    // Arrange
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
    const result = await runScenario(connectScenario({}), {
      HOME: scratch.path,
    });

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'from-home',
      host: fromConfig.host,
    });
  });

  test('the default context and the default host of the platform when nothing selects an engine', async () => {
    // Arrange
    await using scratch = await scratchDirectory();

    // Act
    const result = await runScenario(connectScenario({}), {
      HOME: scratch.path,
    });

    // Assert
    const defaultHost =
      process.platform === 'win32'
        ? 'npipe:////./pipe/docker_engine'
        : 'unix:///var/run/docker.sock';
    const selected = lastJson(result);
    // The machine may or may not run an engine on the default host.
    assert.ok(
      isDeepEqual(selected, { context: 'default', host: defaultHost }) ||
        isDeepEqual(selected, {
          error: 'ConnectionFailedError',
          host: defaultHost,
        }),
      JSON.stringify(selected),
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
    const result = await runScenario(connectScenario({ context: 'named' }), {
      HOME: scratch.path,
      DOCKER_CONFIG: config,
      DOCKER_HOST: fromHost.host,
      DOCKER_CONTEXT: 'other',
    });

    // Assert
    assert.deepEqual(lastJson(result), { context: 'named', host: named.host });
    assert.deepEqual(fromHost.paths, []);
  });

  test('a host option ignores DOCKER_HOST and DOCKER_CONTEXT', async () => {
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
    const result = await runScenario(connectScenario({ host: given.host }), {
      HOME: scratch.path,
      DOCKER_CONFIG: config,
      DOCKER_HOST: fromHost.host,
      DOCKER_CONTEXT: 'other',
    });

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'default',
      host: given.host,
    });
    assert.deepEqual(fromHost.paths, []);
  });

  test('a context that the context store does not have is a ContextNotFoundError, from the option or from DOCKER_CONTEXT', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const config = join(scratch.path, 'docker-config');
    await writeContextStore(config, { contexts: {} });
    const env = { HOME: scratch.path, DOCKER_CONFIG: config };

    // Act
    const fromOption = await runScenario(
      connectScenario({ context: 'absent' }),
      env,
    );
    const fromVariable = await runScenario(connectScenario({}), {
      ...env,
      DOCKER_CONTEXT: 'absent',
    });

    // Assert
    const expected = { error: 'ContextNotFoundError', context: 'absent' };
    assert.deepEqual(lastJson(fromOption), expected);
    assert.deepEqual(lastJson(fromVariable), expected);
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
    const env = { HOME: scratch.path, DOCKER_CONFIG: config };

    // Act
    const results = [
      await runScenario(connectScenario({ host: fromOption }), env),
      await runScenario(connectScenario({}), {
        ...env,
        DOCKER_HOST: fromVariable,
      }),
      await runScenario(connectScenario({}), env),
    ];

    // Assert
    assert.deepEqual(
      results.map((result) => lastJson(result)),
      [fromOption, fromVariable, fromContext].map((host) => ({
        error: 'UnsupportedHostError',
        host,
      })),
    );
  });

  test('the context option default is the default host of the platform, whatever DOCKER_HOST is', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    await using fromHost = await fakeEngine({
      directory: await mkdirIn(scratch.path, 'host'),
      apiVersion: '1.51',
    });

    // Act
    const result = await runScenario(connectScenario({ context: 'default' }), {
      HOME: scratch.path,
      DOCKER_HOST: fromHost.host,
    });

    // Assert
    const defaultHost =
      process.platform === 'win32'
        ? 'npipe:////./pipe/docker_engine'
        : 'unix:///var/run/docker.sock';
    const selected = lastJson(result);
    // The machine may or may not run an engine on the default host.
    assert.ok(
      isDeepEqual(selected, { context: 'default', host: defaultHost }) ||
        isDeepEqual(selected, {
          error: 'ConnectionFailedError',
          host: defaultHost,
        }),
      JSON.stringify(selected),
    );
    assert.deepEqual(fromHost.paths, []);
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
    const result = await runScenario(connectScenario({}), {
      HOME: scratch.path,
      DOCKER_CONFIG: config,
      DOCKER_HOST: '',
      DOCKER_CONTEXT: '',
    });

    // Assert
    assert.deepEqual(lastJson(result), {
      context: 'from-config',
      host: fromConfig.host,
    });
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
    const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
console.log(JSON.stringify(await Docker.contexts()));
`;
    const env = { HOME: scratch.path, DOCKER_CONFIG: config };

    // Act
    const fromConfig = await runScenario(scenario, env);
    const fromVariable = await runScenario(scenario, {
      ...env,
      DOCKER_CONTEXT: 'remote-box',
    });
    const fromHost = await runScenario(scenario, {
      ...env,
      DOCKER_HOST: 'unix:///tmp/other.sock',
    });

    // Assert
    const defaultHost =
      process.platform === 'win32'
        ? 'npipe:////./pipe/docker_engine'
        : 'unix:///var/run/docker.sock';
    assert.deepEqual(lastJson(fromConfig), [
      { name: 'default', host: defaultHost, current: false },
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
      currentNames(lastJson(fromVariable)),
      ['remote-box'],
      'DOCKER_CONTEXT makes its context current',
    );
    assert.deepEqual(
      lastJson(fromHost),
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

  test('gives only the default context when the configuration directory does not exist', async () => {
    // Arrange
    await using scratch = await scratchDirectory();
    const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
console.log(JSON.stringify(await Docker.contexts()));
`;

    // Act
    const result = await runScenario(scenario, {
      HOME: scratch.path,
      DOCKER_CONFIG: join(scratch.path, 'absent'),
    });

    // Assert
    assert.deepEqual(lastJson(result), [
      {
        name: 'default',
        host:
          process.platform === 'win32'
            ? 'npipe:////./pipe/docker_engine'
            : 'unix:///var/run/docker.sock',
        current: true,
      },
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

function currentNames(contexts: unknown): string[] {
  assert.ok(Array.isArray(contexts));
  return contexts.flatMap((context: unknown) =>
    Reflect.get(Object(context), 'current') === true
      ? [String(Reflect.get(Object(context), 'name'))]
      : [],
  );
}
