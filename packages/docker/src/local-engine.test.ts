import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Docker } from './index.ts';
import { ENTRY, lastJson, runScenario } from './testing/scenario.ts';
import { localEngineSocket } from './testing/ssh-stand-in.ts';

const engineSocket = await localEngineSocket();

describe('the engine that the environment of the test run selects', () => {
  test('connect() gives its host and a supported API version, and info() answers', async () => {
    // Arrange
    const signal = AbortSignal.timeout(10_000);

    // Act
    await using docker = await Docker.connect({
      environment: process.env,
      signal,
    });
    const info = await docker.info({ signal });

    // Assert
    assert.match(docker.host, /^(unix|npipe|ssh):\/\/./);
    assert.match(docker.apiVersion, /^1\.\d+$/);
    const minor = Number(docker.apiVersion.split('.')[1]);
    assert.ok(minor >= 44 && minor <= 56, docker.apiVersion);
    assert.equal(typeof info.ServerVersion, 'string');
    assert.equal(typeof info.ID, 'string');
    assert.deepEqual(docker.cliEnvironment, {
      DOCKER_HOST: docker.host,
      DOCKER_CONTEXT: undefined,
    });
  });
});

describe('the local engine of this machine on its Unix socket', () => {
  test(
    '20 requests in sequence on one kept connection give no MaxListenersExceededWarning',
    {
      skip:
        engineSocket === undefined
          ? 'the current context of config.json is not a local unix:// engine'
          : false,
    },
    async () => {
      // Arrange
      const scenario = `
import { Docker } from ${JSON.stringify(ENTRY)};
const warnings = [];
process.on('warning', (warning) => warnings.push(warning.name + ': ' + warning.message));
const docker = await Docker.connect({ host: ${JSON.stringify(`unix://${engineSocket}`)}, signal: AbortSignal.timeout(20_000) });
for (let request = 0; request < 20; request++) await docker.info();
await docker[Symbol.asyncDispose]();
console.log(JSON.stringify({ warnings }));
`;

      // Act
      const result = await runScenario(scenario, {});

      // Assert
      assert.deepEqual(lastJson(result), { warnings: [] }, result.stderr);
    },
  );
});
