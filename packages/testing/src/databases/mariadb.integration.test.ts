import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import mariadb from 'mariadb';
import command from 'nano-spawn';

import { Docker, TestRun, skipWithoutDocker } from '../docker/index.ts';
import { Mariadb } from './mariadb.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const skip = await skipWithoutDocker(docker, process.env);

test(
  'a dedicated MariaDB server gives the official driver its requested database and leaves with its container',
  { skip, timeout: 180_000 },
  async (t) => {
    const database = `owned_${randomUUID().replaceAll('-', '')}`;
    const server = await new Mariadb({ docker, database }).start();
    const id = server.containerId;
    {
      await using owned = server;
      const { stdout: image } = await command('docker', [
        'inspect',
        '--format',
        '{{.Config.Image}}',
        id,
      ]);
      assert.equal(image, 'mariadb:lts');
      assert.equal(owned.image, image);
      const connection = await mariadb.createConnection(owned.connectionString);
      try {
        const [row] = await connection.query(
          'SELECT VERSION() AS version, DATABASE() AS name',
        );
        assert.match(row.version, /MariaDB/);
        assert.equal(row.name, database);
      } finally {
        await connection.end();
      }
      assert.deepEqual(
        await owned.query('SELECT 42 AS value, NULL AS missing'),
        [{ value: '42', missing: null }],
      );
    }
    await t.waitFor(
      async () => {
        const { stdout } = await command('docker', [
          'ps',
          '-aq',
          '--filter',
          `id=${id}`,
        ]);
        assert.equal(stdout, '');
      },
      { timeout: 5_000 },
    );
  },
);
