import { selectorRule } from '../authoring/selector-rule.ts';

// `test` and `globals` as an identifier key or a string key.
const TEST = ':matches([key.name="test"], [key.value="test"])';
const GLOBALS = ':matches([key.name="globals"], [key.value="globals"])';

/**
 * `test.globals: true` puts describe, it, expect and vi in every test file's
 * scope with no import, and the `vitest/globals` types that go with it let the
 * type check accept them. A test file then reads names that nothing in it
 * declares. With globals off (Vitest's default) and the types removed, the
 * type check rejects a `describe` with no import.
 */
export default selectorRule({
  description:
    'Disallow test.globals: true in a Vite or Vitest config: each test file imports describe, it and expect from vitest',
  message:
    "test.globals: true puts describe, it, expect and vi in scope with no import. Delete it (false is Vitest's default), import them from 'vitest' in each test file, and remove 'vitest/globals' from the tsconfig types, so the type check rejects a test that uses one without an import.",
  selectors: [
    `Property${TEST} > ObjectExpression > Property${GLOBALS}[value.value=true]`,
  ],
});
