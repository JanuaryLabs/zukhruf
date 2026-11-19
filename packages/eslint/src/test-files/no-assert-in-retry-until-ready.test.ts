import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-assert-in-retry-until-ready';

/** Lints `src/ready.test.ts`, holding `lines`, with `zukhruf/tests`, and returns the line of each finding of the rule. */
async function reportedLines(lines: string[]): Promise<number[]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    // `types: []` keeps the fixture from loading @types the temporary folder does not have.
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ['**/*.ts'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/tests'] }`,
    ),
    'src/ready.test.ts': `${lines.join('\n')}\n`,
  });
  const findings = lint(workspace.root, ['src/ready.test.ts']);
  const own = findings.filter(({ ruleId }) => ruleId === RULE);
  for (const { message } of own) {
    assert.match(
      message,
      /use waitFor\(\(\) => \{ assert… \}, \{ signal: t\.signal \}\) from @zukhruf\/testing\/async/,
    );
  }
  return own.map(({ line }) => line);
}

test('a retryUntilReady whose check calls an assertion of node:assert is reported, also aliased, through a namespace, and in a nested function', async () => {
  // Act
  const lines = await reportedLines([
    `import assert, { equal } from 'node:assert/strict';`,
    `import * as wait from '@zukhruf/testing/async';`,
    `import { retryUntilReady, retryUntilReady as ready } from '@zukhruf/testing/async';`,
    `declare const rows: () => string[];`,
    `await retryUntilReady(() => assert.equal(rows().length, 1));`,
    `await ready(() => { assert(rows().length > 0); });`,
    `await wait.retryUntilReady(() => equal(rows()[0], 'a'));`,
    `await retryUntilReady(async () => { rows().forEach((row) => assert.ok(row)); });`,
  ]);

  // Assert
  assert.deepEqual(lines, [5, 6, 7, 8]);
});

test('a retryUntilReady whose shouldRetry names AssertionError is reported, though its check calls no assertion itself', async () => {
  // Act
  const lines = await reportedLines([
    `import assert from 'node:assert/strict';`,
    `import { retryUntilReady } from '@zukhruf/testing/async';`,
    `declare const check: () => void;`,
    `await retryUntilReady(check, { shouldRetry: ({ error }) => error instanceof assert.AssertionError });`,
  ]);

  // Assert
  assert.deepEqual(lines, [4]);
});

test('a readiness probe that throws, waitFor that polls an assertion, another module’s retryUntilReady and the old name timebox are not reported', async () => {
  // Act
  const lines = await reportedLines([
    `import assert from 'node:assert/strict';`,
    `import { retryUntilReady as fromTesting, timebox, waitFor } from '@zukhruf/testing/async';`,
    `import { retryUntilReady } from 'retry-helpers';`,
    `declare const t: { signal: AbortSignal };`,
    `declare const rows: () => string[];`,
    `await fromTesting(async () => { const ping = await fetch('http://127.0.0.1/_ping'); if (!ping.ok) throw new Error(String(ping.status)); }, { shouldRetry: ({ error }) => error instanceof TypeError });`,
    `await waitFor(() => assert.equal(rows().length, 1), { signal: t.signal });`,
    `await retryUntilReady(() => assert.equal(rows().length, 1));`,
    `await timebox(() => assert.equal(rows().length, 1));`,
  ]);

  // Assert
  assert.deepEqual(lines, []);
});
