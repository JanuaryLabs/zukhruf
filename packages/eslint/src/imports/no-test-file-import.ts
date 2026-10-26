import { selectorRule } from '../authoring/selector-rule.ts';
import { TEST_EXTENSIONS } from '../files.ts';

const TEST_FILE = `/\\.(test|spec)\\.(${TEST_EXTENSIONS.join('|')})$/`;

/**
 * A `.test.`/`.spec.` file is a test entry point: `node --test` runs each one
 * it finds, so a module that imports one runs its tests again, and a test file
 * that exports helpers mixes two jobs. Code that tests share lives in a file
 * without the suffix, for example in `src/testing`.
 */
export default selectorRule({
  description: 'Disallow an import of a .test. or .spec. file',
  selectors: [
    `ImportDeclaration[source.value=${TEST_FILE}]`,
    `ExportNamedDeclaration[source.value=${TEST_FILE}]`,
    `ExportAllDeclaration[source.value=${TEST_FILE}]`,
    `ImportExpression[source.value=${TEST_FILE}]`,
    `CallExpression[callee.name="require"] > Literal.arguments[value=${TEST_FILE}]`,
  ],
  message:
    'A .test./.spec. file is a test entry point: node --test runs it. Move the shared code to a file without the suffix.',
});
