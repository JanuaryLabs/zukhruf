import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './require-msw-error-on-unhandled-request.ts';

const withMsw = (listen: string) =>
  `import { setupServer } from 'msw/node';\nconst server = setupServer();\n${listen}`;

test('require-msw-error-on-unhandled-request', () => {
  typescriptRuleTester().run('require-msw-error-on-unhandled-request', rule, {
    valid: [
      { code: withMsw(`server.listen({ onUnhandledFrame: 'error' });`) },
      // msw 2's name for the same option.
      { code: withMsw(`server.listen({ onUnhandledRequest: 'error' });`) },
      // Without the msw/node import, listen() belongs to something else.
      { code: `app.listen(); server.listen({ port: 1 });` },
    ],
    invalid: [
      { code: withMsw(`server.listen();`), errors: [{ messageId: 'matched' }] },
      {
        code: withMsw(`server.listen({ onUnhandledFrame: 'warn' });`),
        errors: [{ messageId: 'matched' }],
      },
      {
        code: withMsw(`server.listen({ onUnhandledRequest: 'warn' });`),
        errors: [{ messageId: 'matched' }],
      },
      // Only these two option names count.
      {
        code: withMsw(`server.listen({ onUnhandled: 'error' });`),
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
