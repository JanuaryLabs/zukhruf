import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import mysql, { type RowDataPacket } from 'mysql2/promise';
import command from 'nano-spawn';

import { Docker, TestRun } from '../docker/index.ts';
import { Mysql } from './mysql.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
test(
  'a dedicated MySQL server gives a driver its requested database and leaves with its container',
  { timeout: 180_000 },
  async (t) => {
    const database = `owned_${randomUUID().replaceAll('-', '')}`;
    const server = await new Mysql({ docker, database }).start();
    const id = server.containerId;
    {
      await using owned = server;
      const { stdout: image } = await command('docker', [
        'inspect',
        '--format',
        '{{.Config.Image}}',
        id,
      ]);
      assert.equal(image, 'mysql:lts');
      assert.equal(owned.image, image);
      assert.equal(new URL(owned.connectionString).protocol, 'mysql:');
      const connection = await mysql.createConnection(owned.connectionString);
      try {
        const [[row]] = await connection.query<RowDataPacket[]>(
          'SELECT DATABASE() AS name',
        );
        assert.equal(row?.name, database);
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
