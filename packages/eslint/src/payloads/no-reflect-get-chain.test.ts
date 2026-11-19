import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-reflect-get-chain';

/** Lints `src/payload.ts`, holding `lines`, with `zukhruf/base`, and returns the line of each finding of the rule. */
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
    'src/payload.ts': `${lines.join('\n')}\n`,
  });
  const own = lint(workspace.root, ['src/payload.ts']).filter(
    ({ ruleId }) => ruleId === RULE,
  );
  for (const { message } of own) {
    assert.match(
      message,
      /^Do not walk a payload with Reflect\.get on Reflect\.get\. Type the payload from the real data/,
    );
  }
  return own.map(({ line }) => line);
}

test('a Reflect.get on a Reflect.get is reported: nested, through Object(), as, satisfies and !, and through a variable set from one', async () => {
  // Act
  const lines = await reportedLines([
    `declare const meta: object;`,
    `export const nested: unknown = Reflect.get(Reflect.get(meta, 'Endpoints'), 'docker');`,
    `export const boxed: unknown = Reflect.get(Object(Reflect.get(meta, 'Endpoints')), 'docker');`,
    `export const cast: unknown = Reflect.get(Reflect.get(meta, 'a') as object, 'b');`,
    `export const checked: unknown = Reflect.get(Reflect.get(meta, 'a') satisfies object, 'b');`,
    `export const asserted: unknown = Reflect.get(Reflect.get(meta, 'a')!, 'b');`,
    `export function host(): unknown {`,
    `  const endpoints: unknown = Reflect.get(meta, 'Endpoints');`,
    `  const docker: unknown = Reflect.get(Object(endpoints), 'docker');`,
    `  return Reflect.get(Object(docker), 'Host');`,
    `}`,
  ]);

  // Assert
  assert.deepEqual(lines, [2, 3, 4, 5, 6, 9, 10]);
});

test('one Reflect.get on an object, a dynamic key or a parsed value, and a variable that a Reflect.get does not set, are not reported', async () => {
  // Act
  const lines = await reportedLines([
    `declare const record: Record<string, object>;`,
    `declare const key: string;`,
    `export const one: unknown = Reflect.get(record, key);`,
    `const entry = record[key];`,
    `export const field: unknown = entry === undefined ? undefined : Reflect.get(entry, 'name');`,
    `export function read(): unknown {`,
    `  let value: object = record;`,
    `  value = Object(Reflect.get(record, key));`,
    `  return Reflect.get(value, 'name');`,
    `}`,
    `export const parsed: unknown = Reflect.get(JSON.parse('{}'), 'name');`,
  ]);

  // Assert
  assert.deepEqual(lines, []);
});
