import { test } from 'node:test';

import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-missing-test-timeout.ts';

const ruleTester = jsonRuleTester();

test('a project.json target that runs node --test without --test-timeout is reported', () => {
  // Arrange
  const code = JSON.stringify({
    targets: { test: { command: 'node --test "src/**/*.test.ts"' } },
  });

  // Act + Assert
  ruleTester.run('no-missing-test-timeout', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'packages/lib/project.json',
        errors: [{ messageId: 'missingTestTimeout', data: { target: 'test' } }],
      },
    ],
  });
});

test('a test run in options.command or options.commands of nx:run-commands is reported', () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      e2e: {
        executor: 'nx:run-commands',
        options: { command: 'npx tsx --test src/e2e.test.ts' },
      },
      verify: {
        executor: 'nx:run-commands',
        options: {
          commands: [
            'tsc -b',
            { command: 'DEBUG=1 node --test --no-warnings src/a.test.ts' },
          ],
        },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-missing-test-timeout', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'packages/lib/project.json',
        errors: [
          { messageId: 'missingTestTimeout', data: { target: 'e2e' } },
          { messageId: 'missingTestTimeout', data: { target: 'verify' } },
        ],
      },
    ],
  });
});

test('a test run in the nx key of a package.json is reported', () => {
  // Arrange
  const code = JSON.stringify({
    name: '@acme/lib',
    nx: { targets: { test: { command: 'node --test src/lib.test.ts' } } },
  });

  // Act + Assert
  ruleTester.run('no-missing-test-timeout', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'packages/lib/package.json',
        errors: [{ messageId: 'missingTestTimeout', data: { target: 'test' } }],
      },
    ],
  });
});

test('a test run with --test-timeout, and a target that runs no test, pass', () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      test: {
        command: 'node --test --test-timeout=300000 "src/**/*.test.ts"',
      },
      network: {
        command: 'node --test --test-timeout 600000 src/network.spec.ts',
      },
      build: { command: 'tsc -b' },
      // --test after the script is the script's own argument.
      seed: { command: 'node scripts/seed.ts --test' },
    },
  });

  // Act + Assert
  ruleTester.run('no-missing-test-timeout', rule, {
    valid: [{ code, filename: 'packages/lib/project.json' }],
    invalid: [],
  });
});
