import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-api-error-instanceof.ts';

test('no-api-error-instanceof', () => {
  typescriptRuleTester().run('no-api-error-instanceof', rule, {
    valid: [
      {
        code: `import { APIError } from '@workspace/client';\nif (error instanceof APIError) throw error;`,
      },
      {
        code: `import { isAPIError } from 'better-auth/api';\nif (isAPIError(error)) throw error;`,
      },
      {
        code: `import { BetterAuthError } from 'better-auth';\nif (error instanceof BetterAuthError) throw error;`,
      },
      {
        code: `import * as client from '@workspace/client';\nif (error instanceof client.APIError) throw error;`,
      },
    ],
    invalid: [
      {
        code: `import { APIError } from 'better-auth/api';\nif (error instanceof APIError) throw error;`,
        errors: [{ messageId: 'instanceof' }],
      },
      {
        code: `import * as api from 'better-auth/api';\nif (error instanceof api.APIError) throw error;`,
        errors: [{ messageId: 'instanceof' }],
      },
      ...[
        'better-auth',
        'better-auth/api',
        '@better-auth/core/error',
        'better-call',
        'better-call/error',
      ].map((source) => ({
        code: `import { APIError as AuthError } from '${source}';\nif (error instanceof AuthError) throw error;`,
        errors: [{ messageId: 'instanceof' }],
      })),
    ],
  });
});
