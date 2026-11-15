import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DockerTestbed } from './index.ts';

test('an environment with only one of the two run variables is refused', () => {
  assert.throws(
    () =>
      new DockerTestbed({ environment: { ZUKHRUF_TESTING_RUN_ID: 'run-1' } }),
    /ZUKHRUF_TESTING_RUN_ID and ZUKHRUF_TESTING_RUN_DIR together/,
  );
  assert.throws(
    () =>
      new DockerTestbed({
        environment: { ZUKHRUF_TESTING_RUN_DIR: '/tmp/run-1' },
      }),
    /ZUKHRUF_TESTING_RUN_ID and ZUKHRUF_TESTING_RUN_DIR together/,
  );
});

test('a process outside a run labels what it creates with no run', async () => {
  const testbed = new DockerTestbed({ environment: { PATH: '/usr/bin' } });

  const { Labels } = await testbed.defaults();

  assert.deepEqual(Labels, {});
});
