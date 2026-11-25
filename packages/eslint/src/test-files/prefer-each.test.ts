import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typescriptRuleTester } from '../testing/rule-tester.ts';
import { fixtureConfig, printConfig } from '../testing/run-eslint.ts';
import { isRecord } from '../unknown-values.ts';
import rule from './prefer-each.ts';

test('prefer-each reports a loop outside a test case that declares a test or a suite, once, and the innermost of nested loops', () => {
  typescriptRuleTester().run('prefer-each', rule, {
    valid: [],
    invalid: [
      `for (const [name, fusion] of fusions) {\n  test(name, () => {});\n}`,
      `for (let index = 0; index < 3; index++) {\n  it(String(index), () => {});\n}`,
      `for (const key in table) {\n  suite(key, () => {});\n}`,
      `for (const row of rows) {\n  test.only(row, () => {});\n}`,
      `for (const row of rows) {\n  describe(row, () => {\n    test('a', () => {});\n    test('b', () => {});\n  });\n}`,
      `for (const row of rows) {\n  void test.each(row.cases, (item) => test(item, () => {}));\n}`,
      `for (const row of rows) {\n  test.each(row.cases)('x', () => {});\n}`,
      `rows.forEach((row) => {\n  test(row, () => {});\n});`,
      `rows.map((row) => test(row, () => {}));`,
    ]
      .map((code) => ({ code, errors: [{ messageId: 'preferEach', line: 1 }] }))
      .concat([
        {
          code: `describe('x', () => {\n  for (const row of rows) {\n    test.skip(row, () => {});\n  }\n});`,
          errors: [{ messageId: 'preferEach', line: 2 }],
        },
        {
          code: `for (const a of as) {\n  for (const b of bs) {\n    test(a + b, () => {});\n  }\n}`,
          errors: [{ messageId: 'preferEach', line: 2 }],
        },
      ]),
  });
});

test('prefer-each passes test.each, a loop inside a test case, and a loop that declares no test', () => {
  typescriptRuleTester().run('prefer-each', rule, {
    valid: [
      `void test.each(rows, (row) => test(\`case \${row}\`, () => {}));`,
      `void suite.each(rows, (row) => suite(row, () => { test('x', () => {}); }));`,
      `test('x', () => {\n  for (const row of rows) {\n    assert.ok(row);\n  }\n});`,
      `test('x', async (t) => {\n  for (const row of rows) {\n    await t.test(row, () => {});\n  }\n});`,
      `test('x', async () => {\n  for (const row of rows) {\n    await test(row, () => {});\n  }\n});`,
      `test.skip('x', async () => {\n  for (const row of rows) {\n    await test(row, () => {});\n  }\n});`,
      `it('x', () => {\n  rows.forEach((row) => assert.ok(row));\n});`,
      `for (const test of tests) {\n  test.run();\n}`,
      `for (const row of rows) {\n  check(row);\n}`,
      `const cases = rows.map((row) => ({ ...row, at: 0 }));`,
      `items.forEach((item) => {\n  process(item);\n});`,
      `for (const row of rows) {\n  object.test(row, () => {});\n}`,
    ],
    invalid: [],
  });
});

test('the tests config turns prefer-each on as a warning for a test file', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ['**/*.ts'],
    }),
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/tests'] }`,
    ),
    'src/sum.test.ts': `export {};\n`,
  });

  // Act
  const config = printConfig(workspace.root, 'src/sum.test.ts');

  // Assert
  const rules = isRecord(config) ? config['rules'] : undefined;
  const entry = isRecord(rules) ? rules['zukhruf/prefer-each'] : undefined;
  assert.deepEqual(entry, [1]);
});
