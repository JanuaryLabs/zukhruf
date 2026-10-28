import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

// The runner is a command, so the test runs it as one. --accept checks the
// design name against the scoreboard before it contacts the model, so the
// embedding endpoint here is a port that nothing listens on.
test('--accept with a design name that the scoreboard has refuses before the run, and does not crash', () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'run.ts'), '--accept', '3130'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        EVAL_EMBEDDING_URL_EMBEDDINGGEMMA_2: 'http://127.0.0.1:9/v1',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /ReferenceError/);
  assert.match(result.stderr, /Design 3130 is accepted already/);
});
