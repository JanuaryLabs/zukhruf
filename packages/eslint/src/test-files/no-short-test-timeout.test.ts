import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-short-test-timeout.ts';

const options: [{ minimum: number }] = [{ minimum: 240_000 }];

test('no-short-test-timeout reports a per-test timeout below the limit of the test target', () => {
  typescriptRuleTester().run('no-short-test-timeout', rule, {
    valid: [
      // The limit of the test target, with no option.
      { code: `test('x', async () => {});`, options },
      { code: `test('x', { skip: true }, async () => {});`, options },
      // At or above the minimum.
      { code: `test('x', { timeout: 240_000 }, async () => {});`, options },
      { code: `test('x', { timeout: 300_000 }, async () => {});`, options },
      { code: `describe('x', { timeout: 600_000 }, () => {});`, options },
      // A timeout of something other than a test.
      {
        code: `await t.waitFor(check, { interval: 5, timeout: 10_000 });`,
        options,
      },
      { code: `spawnSync('node', [], { timeout: 1000 });`, options },
      { code: `testing('x', { timeout: 10 }, () => {});`, options },
      { code: `object.test('x', { timeout: 10 }, () => {});`, options },
      // With no minimum there is nothing to compare with.
      { code: `test('x', { timeout: 10 }, async () => {});` },
    ],
    invalid: [
      `test('x', { timeout: 10_000 }, async () => {});`,
      `it('x', { timeout: 2000 }, async () => {});`,
      `describe('x', { timeout: 60_000 }, () => {});`,
      `suite('x', { timeout: 60_000 }, () => {});`,
      `test.only('x', { timeout: 10 }, async () => {});`,
      `t.test('x', { timeout: 10 }, async () => {});`,
      `test.each(rows)('x', { timeout: 10 }, async () => {});`,
      `test('x', { skip, timeout: 10 }, async () => {});`,
      `test('x', { ...onUnix, timeout: 30_000 }, async () => {});`,
      // A value that the rule cannot prove.
      `test('x', { timeout: limit }, async () => {});`,
      `test('x', { timeout: timeoutForGrants(store) }, async () => {});`,
    ].map((code) => ({
      code,
      options,
      errors: [{ messageId: 'matched' }],
    })),
  });
});
