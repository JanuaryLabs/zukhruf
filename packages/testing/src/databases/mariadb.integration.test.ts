import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import mariadb from 'mariadb';

import { DockerTestbed } from '../docker/index.ts';
import { Mariadb } from './mariadb.ts';

const docker = new DockerTestbed({ environment: process.env });
test(
  'a dedicated MariaDB server gives the official driver its requested database and leaves with its container',
  { timeout: 180_000 },
  async (t) => {
    const database = `owned_${randomUUID().replaceAll('-', '')}`;
    const server = await new Mariadb({
      environment: process.env,
      database,
    }).start();
    const id = server.containerId;
    {
      await using owned = server;
      const client = await docker.client();
      const image = (await (await client.containers.find(id))?.inspect())
        ?.Config?.Image;
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
        const client = await docker.client();
        assert.equal(await client.containers.find(id), undefined);
      },
      { timeout: 5_000 },
    );
  },
);
