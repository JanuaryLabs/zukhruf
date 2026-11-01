import assert from 'node:assert/strict';
import { basename } from 'node:path';
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

const reported = (
  findings: { ruleId: string | null; file: string }[],
  ruleId: string,
) =>
  findings
    .filter((finding) => finding.ruleId === ruleId)
    .map(({ file }) => basename(file))
    .sort();

test('base reports a Jest or Mocha import in a test file and in a setup file', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/clock.test.ts': [
      `import { expect, test } from '@jest/globals';`,
      `test('ticks', () => expect(1).toBe(1));`,
      ``,
    ].join('\n'),
    'src/queue.spec.ts': [
      `import { describe } from 'mocha';`,
      `describe('queue', () => {});`,
      ``,
    ].join('\n'),
    'src/jest.setup.ts': [
      `import { run } from 'jest';`,
      `export const runner = run;`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(reported(findings, 'zukhruf/no-other-test-runner'), [
    'clock.test.ts',
    'jest.setup.ts',
    'queue.spec.ts',
  ]);
});

test('an end-to-end folder that turns off the Playwright ban keeps the ban on other test runners', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      [
        `{ plugins: { zukhruf }, extends: ['zukhruf/base'] },`,
        `{ files: ['e2e/**'], rules: { 'zukhruf/no-playwright-test': 'off' } }`,
      ].join('\n'),
    ),
    'e2e/sign-in.spec.ts': [
      `import { test } from '@playwright/test';`,
      `import { expect } from '@jest/globals';`,
      `test('signs in', () => expect(1).toBe(1));`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['e2e']);

  // Assert
  assert.deepEqual(reported(findings, 'zukhruf/no-playwright-test'), []);
  assert.deepEqual(reported(findings, 'zukhruf/no-other-test-runner'), [
    'sign-in.spec.ts',
  ]);
});
