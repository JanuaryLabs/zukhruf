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

test('no-global-test-mock allows mock.module as a top-level statement, which lives as long as the test file process', () => {
  typescriptRuleTester().run('no-global-test-mock', rule, {
    valid: [
      // The subject builds its tool when it loads, so only a mock made before
      // the import reaches it; each test file runs in its own process.
      {
        code: `
          import { describe, it, mock } from 'node:test';
          mock.module('@ai-sdk/tool-web-fetch', {
            namedExports: { experimental_createWebFetchTool: (options) => create(options) },
          });
          const { rss } = await import('@deepagents/retrieval/connectors');
          describe('rss', () => { it('reads', () => {}); });
        `,
      },
    ],
    invalid: [
      `import { mock, test } from 'node:test';\ntest('x', () => { mock.module('pg', {}); });`,
      `import { describe, mock } from 'node:test';\ndescribe('x', () => { mock.module('pg', {}); });`,
      `import { mock } from 'node:test';\nfunction stubPg() { mock.module('pg', {}); }`,
      `import { mock } from 'node:test';\nmock.module('pg', {});\nmock.method(api, 'fetch');`,
      `import { mock } from 'node:test';\nmock.fn();`,
      `import { mock } from 'node:test';\nmock.timers.enable();`,
      `import { mock } from 'node:test';\nmock.property(api, 'url', 'x');`,
      `import { mock } from 'node:test';\nconst pg = mock.module('pg', {});`,
      `import { test } from 'node:test';\ntest.mock.module('pg', {});`,
      `import { it } from 'node:test';\nit.mock.module('pg', {});`,
    ].map((code) => ({ code, errors: [{ messageId: 'matched' }] })),
  });
});
