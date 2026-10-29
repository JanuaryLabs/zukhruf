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
      { code: `function after() {} after();` },
      { code: `const before = () => {}; before();` },
      {
        code: `import { test } from 'node:test'; items.map((t) => t.after(1));`,
      },
      {
        code: `import { describe } from 'node:test'; describe('s', (s) => { s.after(() => {}); });`,
      },
      {
        code: `import { test } from 'vitest'; test('x', (t) => { t.after(() => {}); });`,
      },
    ],
    invalid: [
      ...[
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
      {
        code: `import { after as cleanup } from 'node:test'; cleanup(() => {});`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { beforeEach } from 'vitest'; beforeEach(() => {});`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { test } from 'node:test'; test('x', (t) => { t.after(() => {}); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { test } from 'node:test'; test('x', async (context) => { context.afterEach(() => {}); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { test } from 'node:test'; test('x', { timeout: 1 }, (t) => { t.before(() => {}); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { test } from 'node:test'; test.only('x', (t) => { t.after(() => {}); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { it } from 'node:test'; it('x', function (t) { t.beforeEach(() => {}); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import { test } from 'node:test'; test('x', async (t) => { await t.test('y', (st) => { st.after(() => {}); }); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import type { TestContext } from 'node:test'; function server(t: TestContext) { t.after(() => {}); }`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import test from 'node:test'; test.after(() => {});`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import * as nt from 'node:test'; nt.after(() => {});`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import * as nt from 'node:test'; nt.test('x', (t) => { t.beforeEach(() => {}); });`,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `import * as nt from 'node:test'; nt.test.after(() => {});`,
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});
