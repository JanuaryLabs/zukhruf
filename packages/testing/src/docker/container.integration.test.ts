import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { SubprocessError } from 'nano-spawn';

import { Docker, TestRun, skipWithoutDocker } from './index.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const skip = await skipWithoutDocker(docker, process.env);
const image = 'alpine:latest';

const inspect = async (id: string, format: string): Promise<string> =>
  (await docker.command(['inspect', '--format', format, id])).stdout;

test(
  'a container keeps what it printed after its command exits, until disposal removes it',
  { skip, timeout: 60_000 },
  async (t) => {
    const container = await docker.start({
      image,
      command: ['sh', '-c', 'echo printed; echo complained >&2'],
    });
    try {
      await t.waitFor(
        async () => {
          assert.equal(
            await inspect(container.containerId, '{{.State.Status}}'),
            'exited',
          );
        },
        { timeout: 10_000 },
      );

      const logs = await container.logs();
      await container.cleanup();

      assert.deepEqual(logs.split('\n').toSorted(), ['complained', 'printed']);
      assert.equal(
        (
          await docker.command([
            'ps',
            '-aq',
            '--filter',
            `id=${container.containerId}`,
          ])
        ).stdout,
        '',
      );
    } finally {
      await container.cleanup();
    }
  },
);

test(
  'a container runs its command with the hostname, environment, labels and volume it was given, and publishes no port',
  { skip, timeout: 60_000 },
  async (t) => {
    const scope = randomUUID();
    await using volume = await docker.volume();
    await using container = await docker.start({
      image,
      hostname: 'holder',
      env: { GREETING: 'hello' },
      labels: { 'dev.zukhruf.testing.verification': scope },
      mounts: [{ source: volume.name, target: '/data' }],
      command: [
        'sh',
        '-c',
        'echo "$GREETING from $(hostname)" > /data/greeting; exec sleep 600',
      ],
    });
    await t.waitFor(
      async () => {
        assert.equal(
          (await container.exec(['cat', '/data/greeting'])).stdout,
          'hello from holder',
        );
      },
      { timeout: 10_000 },
    );

    const name = `zukhruf-testing-reader-${scope}`;
    const read = await docker.run({
      image,
      name,
      mounts: [{ source: volume.name, target: '/data', readOnly: true }],
      command: ['cat', '/data/greeting'],
    });

    assert.equal(read, 'hello from holder');
    assert.equal(
      (await docker.command(['ps', '-aq', '--filter', `name=^/${name}$`]))
        .stdout,
      '',
      'a one-shot container is removed after it exits',
    );
    assert.equal(
      await inspect(
        container.containerId,
        '{{index .Config.Labels "dev.zukhruf.testing.verification"}}',
      ),
      scope,
    );
    assert.equal(
      await inspect(container.containerId, '{{json .NetworkSettings.Ports}}'),
      '{}',
    );
  },
);

test(
  'a read-only mount refuses writes from the container',
  { skip, timeout: 60_000 },
  async () => {
    await using volume = await docker.volume();

    await assert.rejects(
      docker.run({
        image,
        mounts: [{ source: volume.name, target: '/data', readOnly: true }],
        command: ['touch', '/data/written'],
      }),
      (error: unknown) =>
        error instanceof SubprocessError &&
        /Read-only file system/.test(error.stderr),
    );
  },
);

test(
  'disposing a container removes the anonymous volumes its image declares',
  { skip, timeout: 60_000 },
  async () => {
    // Postgres declares a data volume. Unlike a server, this container runs
    // without --rm, so only disposal can remove the volume with it.
    const container = await docker.start({
      image: 'postgres:18-alpine',
      command: ['true'],
    });
    const [inspected]: { Mounts: { Type: string; Name: string }[] }[] =
      JSON.parse(
        (await docker.command(['inspect', container.containerId])).stdout,
      );
    const volumes = (inspected?.Mounts ?? [])
      .filter((mount) => mount.Type === 'volume')
      .map((mount) => mount.Name);
    try {
      assert.ok(volumes.length > 0, 'the image declares an anonymous volume');

      await container.cleanup();

      for (const name of volumes) {
        assert.equal(
          (
            await docker.command([
              'volume',
              'ls',
              '-q',
              '--filter',
              `name=^${name}$`,
            ])
          ).stdout,
          '',
        );
      }
    } finally {
      await container.cleanup();
      for (const name of volumes)
        await docker.command(['volume', 'rm', '--force', name]);
    }
  },
);

test(
  'kill stops the main process of a running container',
  { skip, timeout: 60_000 },
  async (t) => {
    await using container = await docker.start({
      image,
      command: ['sleep', '600'],
    });

    await container.kill();

    await t.waitFor(
      async () => {
        assert.equal(
          await inspect(container.containerId, '{{.State.Status}}'),
          'exited',
        );
      },
      { timeout: 10_000 },
    );
    assert.equal(
      await inspect(container.containerId, '{{.State.ExitCode}}'),
      '137',
    );
  },
);

test('disposing a volume removes it', { skip, timeout: 60_000 }, async () => {
  const volume = await docker.volume();
  const listed = async () =>
    (
      await docker.command([
        'volume',
        'ls',
        '-q',
        '--filter',
        `name=^${volume.name}$`,
      ])
    ).stdout;
  assert.equal(await listed(), volume.name);

  await volume[Symbol.asyncDispose]();

  assert.equal(await listed(), '');
});
