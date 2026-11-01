import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have.
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    types: [],
  },
  include: ['**/*.ts'],
});

// A repo spreads Nx's TypeScript preset, which turns on
// no-empty-interface, before zukhruf/base.
const config = [
  `import nx from ${JSON.stringify(import.meta.resolve('@nx/eslint-plugin'))};`,
  fixtureConfig(
    `...nx.configs['flat/typescript'], { plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
  ),
].join('\n');

const typeFindings = (findings: { ruleId: string | null; message: string }[]) =>
  findings
    .map(({ ruleId }) => ruleId)
    .filter(
      (ruleId) =>
        ruleId === '@typescript-eslint/no-namespace' ||
        ruleId === '@typescript-eslint/no-empty-object-type' ||
        ruleId === '@typescript-eslint/no-empty-interface',
    )
    .sort();

test('base lets env.ts add its parsed environment to the ProcessEnv type, as the standard does', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': config,
    'src/env.ts': [
      `const env = { PORT: '3000' };`,
      `type Env = typeof env;`,
      `declare global {`,
      `  namespace NodeJS {`,
      `    interface ProcessEnv extends Env {}`,
      `  }`,
      `}`,
      `export { env };`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert: ESLint linted env.ts (a parse error or a skipped file has no rule).
  assert.deepEqual(
    findings.filter(({ ruleId }) => ruleId === null),
    [],
  );
  assert.deepEqual(typeFindings(findings), []);
});

test('base still reports a value namespace and an empty interface', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': config,
    'src/shapes.ts': [
      `namespace Shapes {`,
      `  export const sides = 4;`,
      `}`,
      `interface Empty {}`,
      `export { Shapes };`,
      `export type { Empty };`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(typeFindings(findings), [
    '@typescript-eslint/no-empty-object-type',
    '@typescript-eslint/no-namespace',
  ]);
});
