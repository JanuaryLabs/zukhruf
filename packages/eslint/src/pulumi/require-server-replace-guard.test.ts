import { test } from 'node:test';

import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './require-server-replace-guard.ts';

const opts = [{ resources: ['hcloud.Server'] }];

test('require-server-replace-guard', () => {
  typescriptRuleTester().run('require-server-replace-guard', rule, {
    valid: [
      {
        code: `new hcloud.Server('x', { name: 'x' }, { ignoreChanges: ['userData'], protect: true });`,
        options: opts,
      },
      {
        // protect inherited from a spread base must not false-positive.
        code: `const base = { protect: true }; new hcloud.Server('x', {}, { ...base, ignoreChanges: ['userData'] });`,
        options: opts,
      },
      {
        // A non-literal (stack-conditional) protect is accepted: a linter
        // can't second-guess a runtime expression.
        code: `new hcloud.Server('x', {}, { ignoreChanges: ['userData'], protect: stack === 'prod' });`,
        options: opts,
      },
      {
        // A configured list replaces the default one rather than adding to it.
        code: `new hcloud.Server('x', {}, { ignoreChanges: ['userData'] });`,
        options: [{ resources: ['aws.ec2.Instance'] }],
      },
    ],
    invalid: [
      {
        // Options written as a TS `as` cast must still be analyzed.
        code: `new hcloud.Server('x', { name: 'x' }, { ignoreChanges: ['userData'] } as hcloud.CustomResourceOptions);`,
        options: opts,
        errors: [{ messageId: 'missingProtect' }],
      },
      {
        // An explicitly disabled protect (literal false) is a violation.
        code: `new hcloud.Server('x', {}, { ignoreChanges: ['userData'], protect: false });`,
        options: opts,
        errors: [{ messageId: 'missingProtect' }],
      },
      {
        // Without options the rule checks hcloud.Server by default.
        code: `new hcloud.Server('x', {}, { ignoreChanges: ['userData'] });`,
        errors: [
          {
            messageId: 'missingProtect',
            data: { resource: 'hcloud.Server' },
          },
        ],
      },
    ],
  });
});
