import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { timebox } from '../async/index.ts';
import { Docker, TestRun, skipWithoutDocker } from './index.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const skip = await skipWithoutDocker(docker, process.env);

interface InspectedMounts {
  Mounts: { Type: string; Name: string }[];
}
interface InspectedIdentity {
  Name: string;
  Config: { Labels: Record<string, string> };
}

const containersLabelled = async (label: string): Promise<string[]> =>
  (await docker.command(['ps', '-aq', '--filter', `label=${label}`])).stdout
    .split('\n')
    .filter(Boolean);

test(
  'disposing an owned server removes its anonymous volumes',
  { skip, timeout: 120_000 },
  async () => {
    await using container = await docker.serve({
      image: 'postgres:18-alpine',
      internalPort: 5432,
      env: { POSTGRES_PASSWORD: 'test' },
    });
    const [inspected]: InspectedMounts[] = JSON.parse(
      (await docker.command(['inspect', container.containerId])).stdout,
    );
    const volumes = (inspected?.Mounts ?? []).filter(
      (mount) => mount.Type === 'volume',
    );
    try {
      assert.ok(
        volumes.length > 0,
        'the image declares an anonymous data volume',
      );

      await container.cleanup();

      for (const { Name } of volumes) {
        const { stdout } = await docker.command([
          'volume',
          'ls',
          '-q',
          '--filter',
          `name=^${Name}$`,
        ]);
        assert.equal(
          stdout,
          '',
          'anonymous data must not outlive its container',
        );
      }
    } finally {
      for (const { Name } of volumes) {
        await docker.command(['volume', 'rm', Name]).catch(() => {});
      }
    }
  },
);

test(
  'Docker identity preserves configuration, ownership, and unfinished creation',
  { skip, timeout: 120_000 },
  async (t) => {
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
    try {
      await using first = await docker.reuse(options);
      await using reordered = await docker.reuse({
        ...options,
        env: { POSTGRES_DB: 'postgres', POSTGRES_PASSWORD: 'testpassword' },
        labels: {
          purpose: 'identity',
          'dev.zukhruf.testing.verification': scope,
        },
      });
      assert.equal(reordered.containerId, first.containerId);
      await using different = await docker.reuse({
        ...options,
        env: { ...options.env, POSTGRES_PASSWORD: 'another-password' },
      });
      assert.notEqual(different.containerId, first.containerId);

      await assert.rejects(
        docker.reuse({
          ...options,
          healthy: () => {
            throw new Error('readiness failed');
          },
        }),
        /readiness failed/,
      );
      await using healthy = await docker.reuse({
        ...options,
        healthy: ({ exec }) =>
          timebox(
            () =>
              exec([
                'psql',
                '-h',
                '127.0.0.1',
                '-U',
                'postgres',
                '-c',
                'SELECT 1',
              ]),
            { maxRetryTime: 60_000 },
          ),
      });
      assert.equal(healthy.containerId, first.containerId);

      const name = `zukhruf-testing-owned-${scope}`;
      await using owned = await docker.serve({ ...options, name });
      await assert.rejects(
        docker.reuse({ ...options, name }),
        /does not match/,
      );
      assert.equal(
        (
          await docker.command([
            'inspect',
            '--format',
            '{{.State.Running}}',
            owned.containerId,
          ])
        ).stdout,
        'true',
      );

      const failedName = `zukhruf-testing-failed-${scope}`;
      await assert.rejects(
        docker.serve({
          ...options,
          name: failedName,
          healthy: () => {
            throw new Error('owned startup failed');
          },
        }),
        /owned startup failed/,
      );
      // Docker stop waits for exit; --rm removal can finish after it returns.
      await t.waitFor(
        async () => {
          const { stdout } = await docker.command([
            'ps',
            '-aq',
            '--filter',
            `name=^/${failedName}$`,
          ]);
          assert.equal(stdout, '');
        },
        { timeout: 5_000 },
      );

      // Reproduce a creator dying between Docker create and start. Preserve the
      // actual identity metadata instead of duplicating the library's hash logic.
      const [inspection]: InspectedIdentity[] = JSON.parse(
        (await docker.command(['inspect', first.containerId])).stdout,
      );
      assert.ok(inspection);
      await first.cleanup();
      await t.waitFor(
        async () => {
          const { stdout } = await docker.command([
            'ps',
            '-aq',
            '--filter',
            `id=${first.containerId}`,
          ]);
          assert.equal(stdout, '');
        },
        { timeout: 5_000 },
      );
      const labelArgs = Object.entries(inspection.Config.Labels).flatMap(
        ([key, value]) => ['--label', `${key}=${value}`],
      );
      await docker.command([
        'create',
        '--rm',
        '--name',
        inspection.Name.slice(1),
        ...labelArgs,
        '-e',
        'POSTGRES_PASSWORD=testpassword',
        '-e',
        'POSTGRES_DB=postgres',
        '--tmpfs',
        '/var/lib/postgresql:rw,size=512m',
        '-P',
        options.image,
      ]);
      await using recovered = await docker.reuse(options);
      assert.notEqual(recovered.containerId, first.containerId);
      assert.equal(
        (
          await docker.command([
            'inspect',
            '--format',
            '{{.State.Running}}',
            recovered.containerId,
          ])
        ).stdout,
        'true',
      );
    } finally {
      for (const id of await containersLabelled(verification)) {
        await docker.command(['rm', '--force', id]);
      }
    }
  },
);
