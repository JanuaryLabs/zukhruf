import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './require-loader-data-type-argument.ts';

test('require-loader-data-type-argument', () => {
  typescriptRuleTester().run('require-loader-data-type-argument', rule, {
    valid: [
      { code: `const data = useLoaderData<typeof loader>();` },
      { code: `const root = useRouteLoaderData<typeof rootLoader>('root');` },
    ],
    invalid: [
      {
        code: `const data: Data = useLoaderData();`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `const root = useRouteLoaderData('root');`,
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
