import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Docker } from './index.ts';

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
