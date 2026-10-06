import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-test-lifecycle-hooks.ts';

test('no-test-lifecycle-hooks', () => {
  typescriptRuleTester().run('no-test-lifecycle-hooks', rule, {
    valid: [
      {
        code: `test('x', () => { try { arrange(); } finally { cleanup(); } });`,
      },
      { code: `const afterwards = later(); hooks.after(() => {});` },
    ],
    invalid: [
      'before',
      'after',
      'beforeEach',
      'afterEach',
      'beforeAll',
      'afterAll',
    ].map((hook) => ({
      code: `${hook}(() => {});`,
      errors: [{ messageId: 'matched' }],
    })),
  });
});
