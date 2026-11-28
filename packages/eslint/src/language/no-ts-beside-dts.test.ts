import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-ts-beside-dts';
const GLOBALS = 'declare global { var probe: string }\nexport {};\n';
const MODULE = 'export const x = 1;\n';

/** Lints `paths` of a workspace holding `files` under src/, with `zukhruf/base`, and returns each finding of the rule as [file, declaration file it names]. */
async function findings(
  files: Record<string, string>,
  paths: string[],
): Promise<[string, string | undefined][]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        jsx: 'preserve',
      },
      include: ['src'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    ...Object.fromEntries(
      Object.entries(files).map(([path, content]) => [`src/${path}`, content]),
    ),
  });
  return (
    await lint(
      workspace.root,
      paths.map((path) => `src/${path}`),
    )
  )
    .filter(({ ruleId }) => ruleId === RULE)
    .map(({ file, message, line }) => {
      assert.equal(line, 1);
      assert.match(
        message,
        /Rename \S+\.d\.m?ts, for example to vite-env\.d\.ts\.$/,
      );
      return [
        relative(workspace.root, file),
        /^(\S+) sits beside this file/.exec(message)?.[1],
      ];
    });
}

test('a .ts or .tsx beside a .d.ts, and a .mts beside a .d.mts, of the same base name are reported', async () => {
  // Act
  const reported = await findings(
    {
      'env.ts': MODULE,
      'env.d.ts': GLOBALS,
      'view.tsx': MODULE,
      'view.d.ts': GLOBALS,
      'loader.mts': MODULE,
      'loader.d.mts': GLOBALS,
    },
    ['env.ts', 'view.tsx', 'loader.mts'],
  );

  // Assert
  assert.deepEqual(reported, [
    ['src/env.ts', 'env.d.ts'],
    ['src/loader.mts', 'loader.d.mts'],
    ['src/view.tsx', 'view.d.ts'],
  ]);
});

test('a declaration file alone, one of another base name, a .mts beside a .d.ts and a .cts beside a .d.cts, which TypeScript all load, are not reported', async () => {
  // Act
  const reported = await findings(
    {
      'vite-env.d.ts': GLOBALS,
      'env.ts': MODULE,
      'loader.mts': MODULE,
      'loader.d.ts': GLOBALS,
      'legacy.cts': MODULE,
      'legacy.d.cts': GLOBALS,
    },
    ['vite-env.d.ts', 'env.ts', 'loader.mts', 'loader.d.ts', 'legacy.cts'],
  );

  // Assert
  assert.deepEqual(reported, []);
});
