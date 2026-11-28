import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-zod-to-json-schema';

/** Lints `src/schema.ts`, holding `lines`, with `zukhruf/base`, and returns the line of each finding of the rule. */
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
    'src/schema.ts': `${lines.join('\n')}\n`,
  });
  const own = (await lint(workspace.root, ['src/schema.ts'])).filter(
    ({ ruleId }) => ruleId === RULE,
  );
  for (const { message } of own) {
    assert.match(
      message,
      /returns \{\} .*Use z\.toJSONSchema\(schema\) of zod 4\./,
    );
  }
  return own.map(({ line }) => line);
}

test('an import of zod-to-json-schema is reported in every form: static, type-only, a subpath, a re-export and a dynamic import', async () => {
  // Act
  const lines = await reportedLines([
    `import { zodToJsonSchema } from 'zod-to-json-schema';`,
    `import type { JsonSchema7Type } from 'zod-to-json-schema';`,
    `import { parseDef } from 'zod-to-json-schema/dist/esm/parseDef.js';`,
    `export { zodToJsonSchema as toSchema } from 'zod-to-json-schema';`,
    `export const lazy = await import('zod-to-json-schema');`,
    `export type { JsonSchema7Type, parseDef, zodToJsonSchema };`,
  ]);

  // Assert
  assert.deepEqual(lines, [1, 2, 3, 4, 5]);
});

test('zod with its own z.toJSONSchema, and a package whose name only starts with zod-to-json-schema, are not reported', async () => {
  // Act
  const lines = await reportedLines([
    `import { z } from 'zod';`,
    `import { toJSONSchema } from 'zod/v4';`,
    `import { convert } from 'zod-to-json-schema-adjacent';`,
    `export const schema = z.toJSONSchema(z.object({ name: z.string() }));`,
    `export { convert, toJSONSchema };`,
  ]);

  // Assert
  assert.deepEqual(lines, []);
});
