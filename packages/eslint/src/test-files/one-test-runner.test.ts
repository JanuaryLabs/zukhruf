import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/one-test-runner';
const NODE_TEST = `import { test } from 'node:test';\ntest('x', () => {});\n`;
const VITEST = `import { test } from 'vitest';\ntest('x', () => {});\n`;

/** Lints every file of `files` that is a test file, in a workspace that holds `files`, with `zukhruf/tests`, and returns each finding of the rule as [file, line, the runner the message names]. */
async function findings(
  files: Record<string, string>,
): Promise<[string, number, string][]> {
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
    ...files,
  });
  return lint(
    workspace.root,
    Object.keys(files).filter((path) => path.endsWith('.test.ts')),
  )
    .filter(({ ruleId }) => ruleId === RULE)
    .map(({ file, line, message }) => [
      relative(workspace.root, file),
      line,
      /^This project runs (Vitest|its tests with node --test)/.exec(
        message,
      )?.[1] ?? message,
    ]);
}

test('a node:test file in a Vitest project, by a vite.config that sets test or by a vitest.config, and a Vitest file in any other project, are reported', async () => {
  // Act
  const reported = await findings({
    'packages/web/project.json': '{}',
    'packages/web/vite.config.ts': `export default { plugins: [], test: { environment: 'happy-dom' } };\n`,
    'packages/web/src/schema.test.ts': NODE_TEST,
    'packages/lib/package.json': '{}',
    'packages/lib/vitest.config.ts': `export default {};\n`,
    'packages/lib/src/bare.test.ts': `import { test } from 'test';\ntest('x', () => {});\n`,
    'packages/api/package.json': '{}',
    'packages/api/src/route.test.ts': `import assert from 'node:assert/strict';\n${VITEST}`,
  });

  // Assert
  assert.deepEqual(reported, [
    ['packages/api/src/route.test.ts', 2, 'its tests with node --test'],
    ['packages/lib/src/bare.test.ts', 1, 'Vitest'],
    ['packages/web/src/schema.test.ts', 1, 'Vitest'],
  ]);
});

test("each file importing its project's runner, a type-only import of the other, and a vite.config whose only test is a plugin's regex filter, are not reported", async () => {
  // Act
  const reported = await findings({
    'packages/web/project.json': '{}',
    'packages/web/vite.config.ts': `export default { test: { environment: 'happy-dom' } };\n`,
    'packages/web/src/view.test.ts': `import type { TestContext } from 'node:test';\n${VITEST}`,
    'packages/api/package.json': '{}',
    'packages/api/vite.config.ts': `export default { plugins: [svg({ test: /\\.svg$/ })] };\ndeclare function svg(options: object): object;\n`,
    'packages/api/src/route.test.ts': NODE_TEST,
  });

  // Assert
  assert.deepEqual(reported, []);
});
