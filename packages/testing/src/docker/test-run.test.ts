import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Docker, TestRun } from './index.ts';

test('a supervisor environment with only one of the two run variables is refused', () => {
  assert.throws(
    () => TestRun.fromEnvironment({ ZUKHRUF_TESTING_RUN_ID: 'run-1' }),
    /ZUKHRUF_TESTING_RUN_ID and ZUKHRUF_TESTING_RUN_DIR together/,
  );
  assert.throws(
    () => TestRun.fromEnvironment({ ZUKHRUF_TESTING_RUN_DIR: '/tmp/run-1' }),
    /ZUKHRUF_TESTING_RUN_ID and ZUKHRUF_TESTING_RUN_DIR together/,
  );
});

test('a process outside a supervisor has no run, and its containers carry no run label', () => {
  const run = TestRun.fromEnvironment({ PATH: '/usr/bin' });

  assert.equal(run, undefined);
  assert.deepEqual(new Docker({ testRun: run }).defaults.labels, {});
});

test('a supervised process gets its run, and Docker labels what it creates with the run', () => {
  const run = TestRun.fromEnvironment({
    ZUKHRUF_TESTING_RUN_ID: 'run-1',
    ZUKHRUF_TESTING_RUN_DIR: '/tmp/run-1',
  });

  assert.ok(run);
  assert.equal(run.id, 'run-1');
  assert.equal(run.directory, '/tmp/run-1');
  assert.deepEqual(new Docker({ testRun: run }).defaults.labels, {
    'dev.zukhruf.testing.run': 'run-1',
  });
});
