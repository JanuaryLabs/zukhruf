import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';

import { TemporaryFiles } from '../fs/temporary-files.ts';
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

test('a process outside a run labels what it creates with no run', () => {
  const testbed = new DockerTestbed({ environment: { PATH: '/usr/bin' } });

  const { Labels } = testbed.defaults;

  assert.deepEqual(Labels, {});
});

test('a process in a run labels what it creates with the run, and reading the labels records the process in the run', async () => {
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-run-',
  );
  const testbed = new DockerTestbed({
    environment: {
      ZUKHRUF_TESTING_RUN_ID: 'run-1',
      ZUKHRUF_TESTING_RUN_DIR: directory.path,
    },
  });

  const { Labels } = testbed.defaults;

  assert.deepEqual(Labels, { 'dev.zukhruf.testing.run': 'run-1' });
  const recorded = (await readdir(directory.path)).map(
    (file) => /^process-(\d+)-[0-9a-f-]{36}\.json$/.exec(file)?.[1],
  );
  assert.deepEqual(recorded, [String(process.pid)]);
});
