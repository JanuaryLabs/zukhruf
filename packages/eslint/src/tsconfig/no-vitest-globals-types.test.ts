import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-vitest-globals-types';

/** Lints every tsconfig of `files`, in a workspace that holds them, with `zukhruf/tsconfig`, and returns each finding of the rule as [file, line]. */
async function findings(
  files: Record<string, string>,
): Promise<[string, number][]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': JSON.stringify({ name: '@acme/source', private: true }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/tsconfig'] }`,
    ),
    ...files,
  });
  return (
    await lint(
      workspace.root,
      Object.keys(files).filter((path) =>
        /(^|\/)tsconfig[^/]*\.json$/.test(path),
      ),
    )
  )
    .filter(({ ruleId }) => ruleId === RULE)
    .map(({ file, line }) => [relative(workspace.root, file), line]);
}

test("'vitest/globals' in compilerOptions.types is reported, in a tsconfig with comments as TypeScript allows", async () => {
  // Act
  const reported = await findings({
    'packages/web/package.json': JSON.stringify({ name: '@acme/web' }),
    'packages/web/tsconfig.spec.json': `{\n  // Nx writes this for a Vitest project.\n  "compilerOptions": {\n    "types": [\n      "vitest/globals",\n      "vitest/importMeta",\n    ],\n  },\n}\n`,
  });

  // Assert
  assert.deepEqual(reported, [['packages/web/tsconfig.spec.json', 5]]);
});

test("the Vitest types other than 'vitest/globals' pass", async () => {
  // Act
  const reported = await findings({
    'packages/web/package.json': JSON.stringify({ name: '@acme/web' }),
    'packages/web/tsconfig.spec.json': JSON.stringify({
      compilerOptions: {
        types: [
          'vitest',
          'vitest/importMeta',
          '@testing-library/jest-dom/vitest',
        ],
      },
    }),
  });

  // Assert
  assert.deepEqual(reported, []);
});
