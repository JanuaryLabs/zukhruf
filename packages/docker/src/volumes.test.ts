import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  Docker,
  NameConflictError,
  OwnedVolume,
  VolumeInUseError,
  VolumeNotFoundError,
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

/** Removes each container, then each volume, with the label of this test run. */
async function removeLabeled(docker: Docker, run: string): Promise<void> {
  const filters = { label: [`${TEST_LABEL}=${run}`] };
  for (const summary of await docker.containers.list({ all: true, filters })) {
    const container = await docker.containers.find(summary.Id);
    await container?.remove({ force: true, v: true });
  }
  for (const { Name } of await docker.volumes.list({ filters })) {
    await (await docker.volumes.find(Name))?.remove({ force: true });
  }
}

describe('docker.volumes', () => {
  test('create() with a taken name rejects with NameConflictError, and createOrGet() gives the existing volume, with no disposal, and leaves it in place', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    try {
      await docker.volumes.create({
        Name: name,
        Labels: { [TEST_LABEL]: run, owner: 'first' },
      });

      // Act
      const second = docker.volumes.create({
        Name: name,
        Labels: { [TEST_LABEL]: run, owner: 'second' },
      });
      await Promise.allSettled([second]);
      const result = await docker.volumes.createOrGet({
        Name: name,
        Labels: { [TEST_LABEL]: run, owner: 'third' },
      });

      // Assert
      await assert.rejects(second, (error) => {
        assert.ok(error instanceof NameConflictError);
        assert.equal(error.kind, 'volume');
        assert.equal(error.takenName, name);
        return true;
      });
      assert.equal(result.created, false);
      assert.equal(result.volume.name, name);
      assert.equal(result.volume instanceof OwnedVolume, false);
      assert.equal(Symbol.asyncDispose in result.volume, false);
      assert.equal((await result.volume.inspect()).Labels?.owner, 'first');
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('createOrGet() with a free name creates the volume and gives an OwnedVolume whose disposal removes it', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    try {
      // Act
      const result = await docker.volumes.createOrGet({
        Name: name,
        Labels: { [TEST_LABEL]: run },
      });

      const inspected = await result.volume.inspect();
      if (result.created) await result.volume[Symbol.asyncDispose]();

      // Assert
      assert.equal(result.created, true);
      assert.ok(result.volume instanceof OwnedVolume);
      assert.equal(inspected.Name, name);
      assert.equal(await docker.volumes.find(name), undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('remove() of a volume that a container uses rejects with VolumeInUseError', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const volume = await docker.volumes.create({
        Labels: { [TEST_LABEL]: run },
      });
      await docker.containers.create({
        Image: IMAGE,
        Cmd: ['true'],
        Labels: { [TEST_LABEL]: run },
        HostConfig: {
          Mounts: [{ Type: 'volume', Source: volume.name, Target: '/data' }],
        },
      });

      // Act
      const removing = volume.remove();

      // Assert
      await assert.rejects(removing, (error) => {
        assert.ok(error instanceof VolumeInUseError);
        assert.equal(error.volume, volume.name);
        assert.equal(error.status, 409);
        return true;
      });
      assert.ok(await docker.volumes.find(volume.name));
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('inspect() of a removed volume rejects with VolumeNotFoundError, its remove() resolves, and find() gives undefined', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const volume = await docker.volumes.create({
        Labels: { [TEST_LABEL]: run },
      });
      await volume.remove();

      // Act
      const inspecting = volume.inspect();
      await Promise.allSettled([inspecting]);
      const removing = volume.remove();
      const found = await docker.volumes.find(volume.name);

      // Assert
      await assert.rejects(inspecting, (error) => {
        assert.ok(error instanceof VolumeNotFoundError);
        assert.equal(error.volume, volume.name);
        return true;
      });
      await removing;
      assert.equal(found, undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('a volume with no name gets one from the engine, list() with a label filter gives it, and the disposal of its OwnedVolume removes it', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const filters = { label: [`${TEST_LABEL}=${run}`] };
    try {
      const volume = await docker.volumes.create({
        Labels: { [TEST_LABEL]: run },
      });

      // Act
      const listed = (await docker.volumes.list({ filters })).map(
        ({ Name }) => Name,
      );
      await volume[Symbol.asyncDispose]();

      // Assert
      assert.notEqual(volume.name, '');
      assert.deepEqual(listed, [volume.name]);
      assert.equal(await docker.volumes.find(volume.name), undefined);
      assert.deepEqual(await docker.volumes.list({ filters }), []);
    } finally {
      await removeLabeled(docker, run);
    }
  });
});
