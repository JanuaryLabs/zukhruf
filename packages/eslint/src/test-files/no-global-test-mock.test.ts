import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-global-test-mock.ts';

test('no-global-test-mock reports the mock of node:test that belongs to no test', () => {
  typescriptRuleTester().run('no-global-test-mock', rule, {
    valid: [
      {
        code: `import { test } from 'node:test';\ntest('x', (t) => { t.mock.method(api, 'fetch'); });`,
      },
      {
        code: `import { type TestContext } from 'node:test';\nfunction refuse(t: TestContext) { t.mock.timers.enable(); }`,
      },
      // A mock of another library.
      { code: `import { mock } from 'bun:test';` },
      // Not node:test's test.
      { code: `const test = { mock: 1 };\nconsole.log(test.mock);` },
    ],
    invalid: [
      `import { describe, mock, test } from 'node:test';`,
      `import { mock } from 'test';`,
      `import { mock as nodeMock } from 'node:test';`,
      `import { test } from 'node:test';\ntest.mock.method(api, 'fetch');`,
      `import { it } from 'node:test';\nit.mock.fn();`,
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});
