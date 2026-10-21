import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DockerFixtures } from '../docker/index.ts';
import { ClickHouse } from './clickhouse.ts';

const docker = new DockerFixtures({ environment: process.env });
test(
  'a ClickHouse server answers in its container and over HTTP on this machine, until disposal removes it',
  { timeout: 180_000 },
  async () => {
    const server = await new ClickHouse({
      docker,
      image: 'clickhouse/clickhouse-server:25.8.28.1',
    }).start();
    try {
      const { stdout } = await server.container.exec({
        Cmd: ['clickhouse-client', '--query', 'SELECT 42'],
      });
      const response = await fetch(
        `http://${server.host}:${server.port}/?query=${encodeURIComponent('SELECT 43')}`,
      );

      assert.equal(stdout, '42\n');
      assert.equal(await response.text(), '43\n');

      await server.cleanup();

      const client = await docker.client();
      assert.equal(
        await client.containers.find(server.container.id),
        undefined,
      );
    } finally {
      await server.cleanup();
    }
  },
);
