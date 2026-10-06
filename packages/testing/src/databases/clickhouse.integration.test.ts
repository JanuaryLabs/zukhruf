import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Docker, TestRun, skipWithoutDocker } from '../docker/index.ts';
import { ClickHouse } from './clickhouse.ts';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const skip = await skipWithoutDocker(docker, process.env);

test(
  'a ClickHouse server answers in its container and over HTTP on this machine, until disposal removes it',
  { skip, timeout: 180_000 },
  async () => {
    const server = await new ClickHouse({
      docker,
      image: 'clickhouse/clickhouse-server:25.8.28.1',
    }).start();
    try {
      const { stdout } = await server.exec([
        'clickhouse-client',
        '--query',
        'SELECT 42',
      ]);
      const response = await fetch(
        `http://${server.host}:${server.port}/?query=${encodeURIComponent('SELECT 43')}`,
      );

      assert.equal(stdout, '42');
      assert.equal(await response.text(), '43\n');

      await server.cleanup();

      assert.equal(
        (
          await docker.command([
            'ps',
            '-aq',
            '--filter',
            `id=${server.containerId}`,
          ])
        ).stdout,
        '',
      );
    } finally {
      await server.cleanup();
    }
  },
);
