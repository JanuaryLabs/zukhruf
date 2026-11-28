import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-nock';

/** Lints `src/api.test.ts`, holding `lines`, with `zukhruf/base`, and returns the line of each finding of the rule. */
async function reportedLines(lines: string[]): Promise<number[]> {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ['**/*.ts'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/api.test.ts': `${lines.join('\n')}\n`,
  });
  const own = (await lint(workspace.root, ['src/api.test.ts'])).filter(
    ({ ruleId }) => ruleId === RULE,
  );
  for (const { message } of own) {
    assert.match(message, /^Stub HTTP with msw; .*@zukhruf\/testing\/msw\./);
  }
  return own.map(({ line }) => line);
}

test('an import of nock is reported in every form: default, type-only, a subpath, a re-export and a dynamic import', async () => {
  // Act
  const lines = await reportedLines([
    `import nock from 'nock';`,
    `import type { Scope } from 'nock';`,
    `import { back } from 'nock/lib/back.js';`,
    `export { default as httpStub } from 'nock';`,
    `export const lazy = await import('nock');`,
    `export type { Scope };`,
    `nock('https://api.example.com').get('/').reply(200); back.setMode('dryrun');`,
  ]);

  // Assert
  assert.deepEqual(lines, [1, 2, 3, 4, 5]);
});

test('msw, and a package whose name only starts with nock, are not reported', async () => {
  // Act
  const lines = await reportedLines([
    `import { http, HttpResponse } from 'msw';`,
    `import { setupServer } from 'msw/node';`,
    `import { knock } from 'nock-knock';`,
    `export const server = setupServer(http.get('https://api.example.com', () => HttpResponse.json({})));`,
    `export { knock };`,
  ]);

  // Assert
  assert.deepEqual(lines, []);
});
