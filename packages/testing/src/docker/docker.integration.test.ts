import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { Docker } from '@zukhruf/docker';

import { timebox } from '../async/index.ts';
import { DockerTestbed } from './index.ts';

/** Removes each container that carries `label`, shared servers too. */
async function removeLabelled(client: Docker, label: string): Promise<void> {
  for (const { Id } of await client.containers.list({
    all: true,
    filters: { label: [label] },
  }))
    await (await client.containers.find(Id))?.remove({ force: true, v: true });
}

test(
  'disposing an owned server removes its anonymous volumes',
  { timeout: 120_000 },
  async () => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    await using server = await testbed.serve({
      image: 'postgres:18-alpine',
      internalPort: 5432,
      env: { POSTGRES_PASSWORD: 'test' },
    });
    const volumes = ((await server.container.inspect()).Mounts ?? [])
      .filter((mount) => mount.Type === 'volume')
      .map((mount) => mount.Name ?? '');
    try {
      assert.ok(
        volumes.length > 0,
        'the image declares an anonymous data volume',
      );

      // Act
      await server.cleanup();

      // Assert
      for (const name of volumes)
        assert.equal(
          await client.volumes.find(name),
          undefined,
          'anonymous data must not outlive its container',
        );
    } finally {
      for (const name of volumes)
        await (
          await client.volumes.find(name)
        )
          ?.remove({ force: true })
          .catch(() => {});
    }
  },
);

test(
  'Docker identity preserves configuration, ownership, and unfinished creation',
  { timeout: 120_000 },
  async (t) => {
    // Arrange
    const testbed = new DockerTestbed({ environment: process.env });
    const client = await testbed.client();
    const scope = randomUUID();
    const verification = `dev.zukhruf.testing.verification=${scope}`;
    const labels = {
      'dev.zukhruf.testing.verification': scope,
      purpose: 'identity',
    };
    const options = {
      image: 'postgres:18-alpine',
      internalPort: 5432,
      env: { POSTGRES_PASSWORD: 'testpassword', POSTGRES_DB: 'postgres' },
      labels,
      tmpfs: ['/var/lib/postgresql:rw,size=512m'],
    };
    const running = async (id: string) =>
      (await (await client.containers.find(id))?.inspect())?.State?.Running;
    try {
      // Act + Assert: the configuration, not the order of its entries, picks the server.
      await using first = await testbed.reuse(options);
      await using reordered = await testbed.reuse({
        ...options,
        env: { POSTGRES_DB: 'postgres', POSTGRES_PASSWORD: 'testpassword' },
        labels: {
          purpose: 'identity',
          'dev.zukhruf.testing.verification': scope,
        },
      });
      assert.equal(reordered.container.id, first.container.id);
      await using different = await testbed.reuse({
        ...options,
        env: { ...options.env, POSTGRES_PASSWORD: 'another-password' },
      });
      assert.notEqual(different.container.id, first.container.id);

      await assert.rejects(
        testbed.reuse({
          ...options,
          healthy: () => {
            throw new Error('readiness failed');
          },
        }),
        /readiness failed/,
      );
      await using healthy = await testbed.reuse({
        ...options,
        healthy: ({ container }) =>
          timebox(
            async () => {
              const { exitCode, output } = await container.exec({
                Cmd: [
                  'psql',
                  '-h',
                  '127.0.0.1',
                  '-U',
                  'postgres',
                  '-c',
                  'SELECT 1',
                ],
              });
              if (exitCode !== 0) throw new Error(output);
            },
            { maxRetryTime: 60_000 },
          ),
      });
      assert.equal(healthy.container.id, first.container.id);

      // Act + Assert: a dedicated server with the name is not a shared one.
      const name = `zukhruf-testing-owned-${scope}`;
      await using owned = await testbed.serve({ ...options, name });
      await assert.rejects(
        testbed.reuse({ ...options, name }),
        /does not match/,
      );
      assert.equal(await running(owned.container.id), true);

      const failedName = `zukhruf-testing-failed-${scope}`;
      await assert.rejects(
        testbed.serve({
          ...options,
          name: failedName,
          healthy: () => {
            throw new Error('owned startup failed');
          },
        }),
        /owned startup failed/,
      );
      // The removal of an auto-removed container can finish after the stop.
      await t.waitFor(
        async () =>
          assert.equal(await client.containers.find(failedName), undefined),
        { timeout: 5_000 },
      );

      // Arrange: a creator that died between create and start. The inspected
      // labels keep the identity, so the test does not repeat the fingerprint.
      const inspection = await first.container.inspect();
      await first.container.remove({ force: true, v: true });
      await t.waitFor(
        async () =>
          assert.equal(
            await client.containers.find(first.container.id),
            undefined,
          ),
        { timeout: 5_000 },
      );
      await client.containers.create(
        {
          Image: options.image,
          Labels: inspection.Config?.Labels ?? {},
          Env: ['POSTGRES_PASSWORD=testpassword', 'POSTGRES_DB=postgres'],
          ExposedPorts: { '5432/tcp': {} },
          HostConfig: {
            AutoRemove: true,
            Tmpfs: { '/var/lib/postgresql': 'rw,size=512m' },
            PortBindings: {
              '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }],
            },
          },
        },
        { name: (inspection.Name ?? '').slice(1) },
      );

      // Act
      await using recovered = await testbed.reuse(options);

      // Assert
      assert.notEqual(recovered.container.id, first.container.id);
      assert.equal(await running(recovered.container.id), true);
    } finally {
      await removeLabelled(client, verification);
    }
  },
);
