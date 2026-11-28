import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-own-module-mock';

/**
 * Lints `packages/app/src/view.test.ts`, holding `lines`, with `zukhruf/tests`
 * in a workspace whose `workspaces` globs match the packages `@acme/data` and
 * `@acme/ui`, and returns each finding of the rule as [line, module it names].
 */
async function findings(lines: string[]): Promise<[number, string][]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': JSON.stringify({
      name: '@acme/source',
      private: true,
      workspaces: ['packages/*', 'packages/shared/*'],
    }),
    'packages/app/package.json': JSON.stringify({ name: '@acme/app' }),
    'packages/shared/data/package.json': JSON.stringify({
      name: '@acme/data',
    }),
    'packages/ui/package.json': JSON.stringify({ name: '@acme/ui' }),
    // `types: []` keeps the fixture from loading @types the temporary folder does not have.
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ['**/*.ts'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/tests'] }`,
    ),
    'packages/app/src/view.test.ts': `${lines.join('\n')}\n`,
  });
  return (await lint(workspace.root, ['packages/app/src/view.test.ts']))
    .filter(({ ruleId }) => ruleId === RULE)
    .map(({ line, message }) => {
      assert.match(
        message,
        /is code of this workspace\. .* Run the real module and replace only what lies outside the workspace: HTTP with msw/,
      );
      return [line, /^'([^']+)'/.exec(message)?.[1] ?? ''];
    });
}

test('a module mock of a relative path or of a package of the same workspace is reported, in each mock API of Vitest, Jest and node:test', async () => {
  // Act
  const reported = await findings([
    `import { mock } from 'node:test';`,
    `declare const vi: any, jest: any, t: any;`,
    `vi.mock('./api.ts', () => ({}));`,
    `vi.doMock('../lib/store.ts', () => ({}));`,
    `vi.mock(import('./api.ts'));`,
    `jest.mock('@acme/ui');`,
    `jest.doMock('@acme/data/hooks', () => ({}));`,
    `jest.unstable_mockModule('@acme/ui/button', () => ({}));`,
    `mock.module('./api.ts', { namedExports: {} });`,
    `t.mock.module('@acme/data', { namedExports: {} });`,
  ]);

  // Assert
  assert.deepEqual(reported, [
    [3, './api.ts'],
    [4, '../lib/store.ts'],
    [5, './api.ts'],
    [6, '@acme/ui'],
    [7, '@acme/data/hooks'],
    [8, '@acme/ui/button'],
    [9, './api.ts'],
    [10, '@acme/data'],
  ]);
});

test('a module mock of a package outside the workspace, of a name that only starts like a workspace package, and calls that are not module mocks (a computed method among them), are not reported', async () => {
  // Act
  const reported = await findings([
    `declare const vi: any, jest: any, t: any, api: any, specifier: string, store: any;`,
    `t.mock.module('@napi-rs/keyring', { namedExports: {} });`,
    `vi.mock('electron');`,
    `jest.mock('node:fs');`,
    `vi.mock('@acme/uikit');`,
    `vi.mock('@acme/source');`,
    `vi.mock(specifier);`,
    `vi.spyOn(api, 'fetch');`,
    `t.mock.method(api, 'fetch');`,
    `store.mock('./api.ts');`,
    `vi.unmock('./api.ts');`,
    `declare const doMock: string;`,
    `vi[doMock]('./api.ts');`,
  ]);

  // Assert
  assert.deepEqual(reported, []);
});
