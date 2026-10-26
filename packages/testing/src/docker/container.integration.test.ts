import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { DockerTestbed } from './index.ts';

const image = 'alpine:latest';

test(
  'a container keeps what it printed after its command exits, until disposal removes it',
  { timeout: 60_000 },
  async (t) => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    const container = await testbed.start({
      Image: image,
      Cmd: ['sh', '-c', 'echo printed; echo complained >&2'],
    });
    try {
      await t.waitFor(
        async () => {
          assert.equal((await container.inspect()).State?.Status, 'exited');
        },
        { timeout: 10_000 },
      );

      // Act
      const { output } = await container.logs();
      await container[Symbol.asyncDispose]();

      // Assert
      assert.deepEqual(output.trimEnd().split('\n').toSorted(), [
        'complained',
        'printed',
      ]);
      assert.equal(await client.containers.find(container.id), undefined);
    } finally {
      await container[Symbol.asyncDispose]();
    }
  },
);

test(
  'a container runs its command with the hostname, environment, labels and volume it was given, and publishes no port',
  { timeout: 60_000 },
  async (t) => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    const scope = randomUUID();
    await using volume = await testbed.volume();
    await using container = await testbed.start({
      Image: image,
      Hostname: 'holder',
      Env: ['GREETING=hello'],
      Labels: { 'dev.zukhruf.testing.verification': scope },
      HostConfig: { Binds: [`${volume.name}:/data`] },
      Cmd: [
        'sh',
        '-c',
        'echo "$GREETING from $(hostname)" > /data/greeting; exec sleep 600',
      ],
    });
    await t.waitFor(
      async () => {
        assert.equal(
          (await container.exec({ Cmd: ['cat', '/data/greeting'] })).stdout,
          'hello from holder\n',
        );
      },
      { timeout: 10_000 },
    );
    const name = `zukhruf-testing-reader-${scope}`;

    // Act
    const read = await testbed.run(
      {
        Image: image,
        HostConfig: { Binds: [`${volume.name}:/data:ro`] },
        Cmd: ['cat', '/data/greeting'],
      },
      { name },
    );

    // Assert
    assert.equal(read.stdout, 'hello from holder\n');
    assert.equal(
      await client.containers.find(name),
      undefined,
      'a one-shot container is removed after it exits',
    );
    const inspected = await container.inspect();
    assert.equal(
      inspected.Config?.Labels?.['dev.zukhruf.testing.verification'],
      scope,
    );
    assert.deepEqual(inspected.NetworkSettings?.Ports ?? {}, {});
  },
);

test(
  'a read-only mount refuses writes from the container',
  { timeout: 60_000 },
  async () => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    await using volume = await testbed.volume();

    // Act
    const result = await testbed.run({
      Image: image,
      HostConfig: { Binds: [`${volume.name}:/data:ro`] },
      Cmd: ['touch', '/data/written'],
    });

    // Assert
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Read-only file system/);
  },
);

test(
  'disposing a container removes the anonymous volumes its image declares',
  { timeout: 60_000 },
  async () => {
    // Arrange: Postgres declares a data volume. Unlike a server, this
    // container is not auto-removed, so only disposal can remove the volume
    // with it.
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    const container = await testbed.start({
      Image: 'postgres:18-alpine',
      Cmd: ['true'],
    });
    const volumes = ((await container.inspect()).Mounts ?? [])
      .filter((mount) => mount.Type === 'volume')
      .map((mount) => mount.Name ?? '');
    try {
      assert.ok(volumes.length > 0, 'the image declares an anonymous volume');

      // Act
      await container[Symbol.asyncDispose]();

      // Assert
      for (const name of volumes)
        assert.equal(await client.volumes.find(name), undefined);
    } finally {
      await container[Symbol.asyncDispose]();
      for (const name of volumes)
        await (await client.volumes.find(name))?.remove({ force: true });
    }
  },
);

test(
  'kill stops the main process of a running container',
  { timeout: 60_000 },
  async (t) => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    await using container = await testbed.start({
      Image: image,
      Cmd: ['sleep', '600'],
    });

    // Act
    await container.kill();

    // Assert
    await t.waitFor(
      async () => {
        assert.equal((await container.inspect()).State?.Status, 'exited');
      },
      { timeout: 10_000 },
    );
    assert.equal((await container.inspect()).State?.ExitCode, 137);
  },
);

test('disposing a volume removes it', { timeout: 60_000 }, async () => {
  // Arrange
  const testbed = new DockerTestbed({ environment: process.env });
  const client = await testbed.client();
  const volume = await testbed.volume();
  assert.equal((await client.volumes.find(volume.name))?.name, volume.name);

  // Act
  await volume[Symbol.asyncDispose]();

  // Assert
  assert.equal(await client.volumes.find(volume.name), undefined);
});
