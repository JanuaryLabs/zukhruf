import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-on-api-error-throw.ts';

test('no-on-api-error-throw', () => {
  typescriptRuleTester().run('no-on-api-error-throw', rule, {
    valid: [
      {
        code: `betterAuth({ onAPIError: { onError: (error) => logger.warn(error) } });`,
      },
      { code: `betterAuth({ onAPIError: { throw: false } });` },
      { code: `const opts = { retry: { throw: true } };` },
    ],
    invalid: [
      {
        code: `export const auth = betterAuth({ onAPIError: { throw: true } });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `const options = { database, onAPIError: { throw: true } } satisfies BetterAuthOptions;\nexport const auth = betterAuth(options);`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `betterAuth({ 'onAPIError': { 'throw': true } });`,
        errors: [{ messageId: 'matched', line: 1 }],
      },
    ],
  });
});
