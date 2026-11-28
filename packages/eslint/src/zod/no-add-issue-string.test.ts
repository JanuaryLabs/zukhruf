import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-add-issue-string';

/** The context of a zod 4 refinement, with the signature of `addIssue` in zod 4.6 (`v4/core/api.d.ts`). */
const REFINEMENT_CONTEXT = `declare const ctx: { addIssue(arg: string | { code: 'custom'; message: string; path?: PropertyKey[] }): void };`;

/** Lints `src/schema.ts`, holding the refinement context and `lines`, with `zukhruf/base`, and returns the line of each finding of the rule. */
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
    'src/schema.ts': `${[REFINEMENT_CONTEXT, ...lines].join('\n')}\n`,
  });
  const own = (await lint(workspace.root, ['src/schema.ts'])).filter(
    ({ ruleId }) => ruleId === RULE,
  );
  for (const { message } of own) {
    assert.match(
      message,
      /^Pass an object: `ctx\.addIssue\(\{ code: 'custom', message \}\)`\. In zod 4 the string form .* stop running\.$/,
    );
  }
  return own.map(({ line }) => line);
}

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('no-add-issue-string', { concurrency: availableParallelism() }, () => {
  test('addIssue given a string is reported: a literal, a template, a variable and a string property', async () => {
    // Act
    const lines = await reportedLines([
      `declare const error: Error;`,
      `ctx.addIssue('Ends before it starts');`,
      `ctx.addIssue(\`Ends \${2} hours before it starts\`);`,
      `const message: string = error.message;`,
      `ctx.addIssue(message);`,
      `ctx.addIssue(error.message);`,
    ]);

    // Assert
    assert.deepEqual(lines, [3, 4, 6, 7]);
  });

  test('addIssue given an issue object, inline or from a variable, and another method given a string are not reported', async () => {
    // Act
    const lines = await reportedLines([
      `declare const list: { add(item: string): void; addIssue(code: string, message: string): void };`,
      `ctx.addIssue({ code: 'custom', message: 'Ends before it starts', path: ['end'] });`,
      `const issue = { code: 'custom' as const, message: 'Too short' };`,
      `ctx.addIssue(issue);`,
      `list.add('Too short');`,
      `list.addIssue('custom', 'Too short');`,
    ]);

    // Assert
    assert.deepEqual(lines, []);
  });
});
