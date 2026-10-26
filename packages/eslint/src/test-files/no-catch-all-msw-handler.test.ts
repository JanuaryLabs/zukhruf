import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-catch-all-msw-handler.ts';

const withMsw = (handler: string) =>
  `import { http, passthrough } from 'msw';\nconst handler = ${handler};`;

test('no-catch-all-msw-handler', () => {
  typescriptRuleTester().run('no-catch-all-msw-handler', rule, {
    valid: [
      { code: withMsw('http.all(`${origin}/*`, () => passthrough())') },
      { code: withMsw(`http.get('https://api.test/users', resolver)`) },
      { code: withMsw(`http.get(/\\/users\\/.*/, resolver)`) },
      { code: withMsw(`router.get('*', resolver)`) },
      // Without an msw import, http.get belongs to something else.
      { code: `http.get('*', resolver);` },
    ],
    invalid: [
      withMsw(`http.all('*', () => passthrough())`),
      withMsw(`http.get('*', resolver)`),
      withMsw(`http.post("*", resolver)`),
      withMsw(`http.all(/.*/, resolver)`),
      withMsw(`http.all(/^.*$/, resolver)`),
      withMsw(`http.all(/.+/, resolver)`),
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});
