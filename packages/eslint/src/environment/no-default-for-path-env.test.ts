import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-default-for-path-env.ts';

const ruleTester = typescriptRuleTester();

const options = [{ pathEnvKeys: ['DATA_DIR'] }];
const errors = [{ messageId: 'noDefault' }];

test('no-default-for-path-env', () => {
  ruleTester.run('no-default-for-path-env', rule, {
    valid: [
      // Only the startup `const env = z.object(...)` schema is checked.
      {
        code: `const body = z.object({ DATA_DIR: z.string().optional() });`,
        options,
      },
      // A computed key resolves at runtime — not the literal pathEnvKey.
      {
        code: `const env = z.object({ [DATA_DIR]: z.string().default('x') });`,
        options,
      },
      // A non-path key with a default is fine.
      {
        code: `const env = z.object({ PORT: z.string().default('3000'), DATA_DIR: z.string() });`,
        options,
      },
    ],
    invalid: [
      {
        code: `const env = z.object({ DATA_DIR: z.string().default('/data') });`,
        options,
        errors,
      },
      // .catch() is also a code-side fallback.
      {
        code: `const env = z.object({ DATA_DIR: z.string().catch('/data') });`,
        options,
        errors,
      },
      // .nullable() lets the path be unset.
      {
        code: `const env = z.object({ DATA_DIR: z.string().nullable() });`,
        options,
        errors,
      },
      // An aliased zod import (zod.object) must still be recognized.
      {
        code: `const env = zod.object({ DATA_DIR: zod.string().default('/data') });`,
        options,
        errors,
      },
    ],
  });
});
