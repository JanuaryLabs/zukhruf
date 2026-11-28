import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { relative } from 'node:path';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-vitest-globals';

/** Lints every file of `files`, in a workspace that holds them, with `zukhruf/base` and `zukhruf/tests`, and returns each finding of the rule as [file, line]. */
async function findings(
  files: Record<string, string>,
): Promise<[string, number][]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    // `types: []` keeps the fixture from loading @types the temporary folder does not have.
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ['**/*.ts', '**/*.mts'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/tests'] }`,
    ),
    ...files,
  });
  return (await lint(workspace.root, Object.keys(files)))
    .filter(({ ruleId }) => ruleId === RULE)
    .map(({ file, line }) => [relative(workspace.root, file), line]);
}

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('no-vitest-globals', { concurrency: availableParallelism() }, () => {
  test('globals: true under test is reported in a vite.config, and in a vitest config by any name, also with string keys and inside a project', async () => {
    // Act
    const reported = await findings({
      'packages/web/vite.config.ts': `export default {\n  test: {\n    globals: true,\n  },\n};\n`,
      'packages/lib/vitest.config.mts': `export default { 'test': { 'globals': true } };\n`,
      'vitest.browser.config.ts': `export default {\n  test: {\n    projects: [{ test: { globals: true } }],\n  },\n};\n`,
    });

    // Assert
    assert.deepEqual(reported, [
      ['packages/lib/vitest.config.mts', 1],
      ['packages/web/vite.config.ts', 3],
      ['vitest.browser.config.ts', 3],
    ]);
  });

  test('globals: false under test, globals: true outside test, and a test block in a file that is not a config pass', async () => {
    // Act
    const reported = await findings({
      'packages/web/vite.config.ts': `const plugin = (options: { globals: boolean }) => ({ name: 'p', options });\nexport default {\n  plugins: [plugin({ globals: true })],\n  test: { globals: false },\n};\n`,
      'packages/web/src/settings.ts': `export const settings = { test: { globals: true } };\n`,
    });

    // Assert
    assert.deepEqual(reported, []);
  });
});
