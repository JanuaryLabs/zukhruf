import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Docker, TestRun } from './index.ts';

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
  const run = TestRun.fromEnvironment({ PATH: '/usr/bin' });

  assert.equal(run, undefined);
  assert.deepEqual(new Docker({ testRun: run }).defaults.labels, {});
});

test('a process in a run gets its run, and Docker labels what it creates with the run', async () => {
  // Reading the labels writes a process record into the run's directory.
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-testing-run-'),
  );
  const run = TestRun.fromEnvironment({
    ZUKHRUF_TESTING_RUN_ID: 'run-1',
    ZUKHRUF_TESTING_RUN_DIR: directory.path,
  });

  assert.ok(run);
  assert.equal(run.id, 'run-1');
  assert.equal(run.directory, directory.path);
  assert.deepEqual(new Docker({ testRun: run }).defaults.labels, {
    'dev.zukhruf.testing.run': 'run-1',
  });
});
