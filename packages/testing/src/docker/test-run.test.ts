import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '../fs/temporary-files.ts';
import { DockerTestbed, TestRun } from './index.ts';

test('an environment with only one of the two run variables is refused', () => {
  assert.throws(
    () => TestRun.fromEnvironment({ ZUKHRUF_TESTING_RUN_ID: 'run-1' }),
    /ZUKHRUF_TESTING_RUN_ID and ZUKHRUF_TESTING_RUN_DIR together/,
  );
  assert.throws(
    () => TestRun.fromEnvironment({ ZUKHRUF_TESTING_RUN_DIR: '/tmp/run-1' }),
    /ZUKHRUF_TESTING_RUN_ID and ZUKHRUF_TESTING_RUN_DIR together/,
  );
});

test('a process outside a run has no run, and its containers carry no run label', () => {
  const environment = { PATH: '/usr/bin' };

  const run = TestRun.fromEnvironment(environment);

  assert.equal(run, undefined);
  assert.deepEqual(new DockerTestbed({ environment }).defaults.labels, {});
});

test('a process in a run gets its run, and Docker labels what it creates with the run', async () => {
  // Reading the labels writes a process record into the run's directory.
  await using directory = await new TemporaryFiles().directory(
    'zukhruf-testing-run-',
  );
  const environment = {
    ZUKHRUF_TESTING_RUN_ID: 'run-1',
    ZUKHRUF_TESTING_RUN_DIR: directory.path,
  };

  const run = TestRun.fromEnvironment(environment);

  assert.ok(run);
  assert.equal(run.id, 'run-1');
  assert.equal(run.directory, directory.path);
  assert.deepEqual(new DockerTestbed({ environment }).defaults.labels, {
    'dev.zukhruf.testing.run': 'run-1',
  });
});
