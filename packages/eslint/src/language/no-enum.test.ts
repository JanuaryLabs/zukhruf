import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-enum.ts';

test('no-enum', () => {
  typescriptRuleTester().run('no-enum', rule, {
    valid: [
      { code: `const Color = { Red: 'red', Blue: 'blue' } as const;` },
      { code: `type Color = 'red' | 'blue';` },
    ],
    invalid: [
      { code: `enum Color { Red, Blue }`, errors: [{ messageId: 'matched' }] },
      {
        code: `export const enum Size { Small = 's' }`,
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
