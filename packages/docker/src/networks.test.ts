import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import {
  ContainerNotFoundError,
  Docker,
  DockerEngineError,
  NameConflictError,
  NetworkInUseError,
  NetworkNotFoundError,
  OwnedNetwork,
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

/** Removes each container, then each network, with the label of this test run. */
async function removeLabeled(docker: Docker, run: string): Promise<void> {
  const filters = { label: [`${TEST_LABEL}=${run}`] };
  for (const summary of await docker.containers.list({ all: true, filters })) {
    const container = await docker.containers.find(summary.Id);
    await container?.remove({ force: true, v: true });
  }
  for (const { Id } of await docker.networks.list({ filters })) {
    await (await docker.networks.find(Id))?.remove();
  }
}

describe('docker.networks', () => {
  test('create() with a taken name rejects with NameConflictError, createOrGet() gives the existing network, and find() and list() give the same ID', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    const filters = { label: [`${TEST_LABEL}=${run}`] };
    try {
      const first = await docker.networks.create({
        Name: name,
        Labels: { [TEST_LABEL]: run },
      });

      // Act
      const second = docker.networks.create({
        Name: name,
        Labels: { [TEST_LABEL]: run },
      });
      await Promise.allSettled([second]);
      const result = await docker.networks.createOrGet({
        Name: name,
        Labels: { [TEST_LABEL]: run },
      });
      const found = await docker.networks.find(name);
      const listed = await docker.networks.list({ filters });

      // Assert
      await assert.rejects(second, (error) => {
        assert.ok(error instanceof NameConflictError);
        assert.equal(error.kind, 'network');
        assert.equal(error.takenName, name);
        assert.equal(error.status, 409);
        return true;
      });
      assert.equal(result.created, false);
      assert.equal(result.network.id, first.id);
      assert.equal(result.network instanceof OwnedNetwork, false);
      assert.equal(found?.id, first.id);
      assert.deepEqual(
        listed.map(({ Id, Name }) => ({ Id, Name })),
        [{ Id: first.id, Name: name }],
      );
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('createOrGet() with a free name creates the network and gives an OwnedNetwork whose disposal removes it, and a remove() of the removed network resolves', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const name = `zukhruf-test-${run}`;
    try {
      // Act
      const result = await docker.networks.createOrGet({
        Name: name,
        Labels: { [TEST_LABEL]: run },
      });
      const inspected = await result.network.inspect();
      if (result.created) await result.network[Symbol.asyncDispose]();
      const removedAgain = result.network.remove();

      // Assert
      assert.equal(result.created, true);
      assert.equal(inspected.Name, name);
      assert.equal(await docker.networks.find(name), undefined);
      await removedAgain;
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('connect() with an alias makes the alias resolvable from another container on the network, and disconnect() takes it away', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const alias = `db-${run.slice(0, 8)}`;
    try {
      const network = await docker.networks.create({
        Name: `zukhruf-test-${run}`,
        Labels: { [TEST_LABEL]: run },
      });
      const server = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      const client = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
        HostConfig: { NetworkMode: network.id },
      });
      await server.start();
      await client.start();
      const lookup = { Cmd: ['getent', 'hosts', alias] };

      // Act
      await network.connect(server, { Aliases: [alias] });
      const connected = await client.exec(lookup);
      await network.disconnect(server);
      const disconnected = await client.exec(lookup);

      // Assert
      const endpoints = (await network.inspect()).Containers ?? {};
      assert.equal(connected.exitCode, 0, connected.output);
      assert.match(connected.stdout, new RegExp(`\\s${alias}\\n$`));
      assert.notEqual(disconnected.exitCode, 0, disconnected.output);
      assert.equal(server.id in endpoints, false);
      assert.equal(client.id in endpoints, true);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('remove() of a network with a running connected container rejects with NetworkInUseError that names the container; without it, the disposal removes the network', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const network = await docker.networks.create({
        Name: `zukhruf-test-${run}`,
        Labels: { [TEST_LABEL]: run },
      });
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await network.connect(container);
      await container.start();

      // Act
      const removing = network.remove();
      await Promise.allSettled([removing]);
      await container.remove({ force: true });
      await network[Symbol.asyncDispose]();

      // Assert
      await assert.rejects(removing, (error) => {
        assert.ok(error instanceof NetworkInUseError);
        assert.equal(error.network, network.id);
        assert.deepEqual(error.containers, [container.id]);
        assert.equal(error.status, 403);
        return true;
      });
      assert.equal(await docker.networks.find(network.id), undefined);
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test("remove() of the pre-defined network 'bridge' rejects with a DockerEngineError with 403, not NetworkInUseError", async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    const bridge = await docker.networks.find('bridge');
    assert.ok(bridge);
    try {
      // A running container on 'bridge', so the network has a connected container, as on the SSH engine.
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      await container.start();

      // Act
      const removing = bridge.remove();

      // Assert
      await assert.rejects(removing, (error) => {
        assert.ok(error instanceof DockerEngineError);
        assert.equal(error instanceof NetworkInUseError, false);
        assert.equal(error.status, 403);
        assert.deepEqual(error.request, {
          method: 'DELETE',
          path: `/networks/${bridge.id}`,
        });
        return true;
      });
      assert.equal((await bridge.inspect()).Name, 'bridge');
    } finally {
      await removeLabeled(docker, run);
    }
  });

  test('inspect() of a removed network, and connect() of a running container to it, reject with NetworkNotFoundError, connect() of a created container to it resolves, and connect() of a removed container rejects with ContainerNotFoundError', async () => {
    // Arrange
    await using docker = await connect();
    const run = randomUUID();
    try {
      const removed = await docker.networks.create({
        Name: `zukhruf-test-${run}-removed`,
        Labels: { [TEST_LABEL]: run },
      });
      await removed.remove();
      const network = await docker.networks.create({
        Name: `zukhruf-test-${run}`,
        Labels: { [TEST_LABEL]: run },
      });
      const container = await docker.containers.create({
        Image: IMAGE,
        Cmd: ['sleep', '300'],
        Labels: { [TEST_LABEL]: run },
      });
      const gone = await docker.containers.create({
        Image: IMAGE,
        Labels: { [TEST_LABEL]: run },
      });
      await gone.remove();
      const created = await docker.containers.create({
        Image: IMAGE,
        Labels: { [TEST_LABEL]: run },
      });
      // The engine keeps the endpoint of a created container for its start, so only a running one gets the 404.
      await container.start();

      // Act
      const inspecting = removed.inspect();
      const toRemoved = removed.connect(container);
      const ofGone = network.connect(gone);
      const ofCreated = removed.connect(created);
      await Promise.allSettled([inspecting, toRemoved, ofGone, ofCreated]);

      // Assert
      await assert.rejects(inspecting, (error) => {
        assert.ok(error instanceof NetworkNotFoundError);
        assert.equal(error.network, removed.id);
        return true;
      });
      await assert.rejects(toRemoved, (error) => {
        assert.ok(error instanceof NetworkNotFoundError);
        assert.equal(error.network, removed.id);
        return true;
      });
      await ofCreated;
      await assert.rejects(ofGone, (error) => {
        assert.ok(error instanceof ContainerNotFoundError);
        assert.equal(error.container, gone.id);
        return true;
      });
    } finally {
      await removeLabeled(docker, run);
    }
  });
});
