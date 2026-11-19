import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const RULE = 'zukhruf/no-ingredients-name';

/** Lints `src/sandbox.ts`, holding `lines`, with `zukhruf/base`, and returns the line of each finding of the rule. */
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
    'src/sandbox.ts': `${lines.join('\n')}\n`,
  });
  const own = lint(workspace.root, ['src/sandbox.ts']).filter(
    ({ ruleId }) => ruleId === RULE,
  );
  for (const { message } of own) {
    assert.match(
      message,
      /^Do not name an API "ingredients": .*Extension, Mixin, Contribution, Module, Parts or Bundle\.$/,
    );
  }
  return own.map(({ line }) => line);
}

test('a variable, a function, a class, a type alias and an interface whose name holds "ingredient" in any case are reported', async () => {
  // Act
  const lines = await reportedLines([
    `export const sqlSandboxIngredients = [];`,
    `export function mergeIngredients() { return sqlSandboxIngredients; }`,
    `export const merge = function ingredientMerger() { return mergeIngredients(); };`,
    `export class SandboxIngredients {}`,
    `export const Anonymous = class INGREDIENT {};`,
    `export type IngredientList = string[];`,
    `export interface Ingredients { readonly parts: IngredientList }`,
  ]);

  // Assert
  assert.deepEqual(lines, [1, 2, 3, 4, 5, 6, 7]);
});

test('a property, a member, a parameter type, a read of a field and the word in a string or a comment are not reported', async () => {
  // Act
  const lines = await reportedLines([
    `// A recipe lists its ingredients.`,
    `export interface Recipe { readonly ingredients: string[]; mergeIngredients(): void }`,
    `export const recipe = { ingredients: ['salt'], title: 'ingredients' };`,
    `export class Kitchen { ingredients: string[] = []; countIngredients() { return this.ingredients.length; } }`,
    `export const count = (dish: Recipe) => dish.ingredients.length;`,
  ]);

  // Assert
  assert.deepEqual(lines, []);
});
