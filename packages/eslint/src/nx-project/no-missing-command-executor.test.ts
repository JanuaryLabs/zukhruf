import { test } from 'node:test';

import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-missing-command-executor.ts';

const ruleTester = jsonRuleTester();

test('a project.json target that sets options.command and no executor is reported', () => {
  // Arrange
  const code = JSON.stringify({
    targets: { serve: { options: { command: 'node src/main.ts' } } },
  });

  // Act + Assert
  ruleTester.run('no-missing-command-executor', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'apps/api/project.json',
        errors: [
          {
            messageId: 'missingExecutor',
            data: { target: 'serve', option: 'command' },
          },
        ],
      },
    ],
  });
});

test('a target that sets options.commands and no executor is reported, also when it has a dependsOn', () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      release: {
        dependsOn: ['build'],
        options: { commands: ['npm pack', 'npm publish'] },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-missing-command-executor', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'packages/lib/project.json',
        errors: [
          {
            messageId: 'missingExecutor',
            data: { target: 'release', option: 'commands' },
          },
        ],
      },
    ],
  });
});

test('a target in the nx key of a package.json that sets options.command and no executor is reported', () => {
  // Arrange
  const code = JSON.stringify({
    name: '@acme/api',
    nx: { targets: { migrate: { options: { command: 'prisma migrate' } } } },
  });

  // Act + Assert
  ruleTester.run('no-missing-command-executor', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'apps/api/package.json',
        errors: [
          {
            messageId: 'missingExecutor',
            data: { target: 'migrate', option: 'command' },
          },
        ],
      },
    ],
  });
});

test('a target that names its executor or sets a top-level command passes', () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      serve: {
        executor: 'nx:run-commands',
        options: { command: 'node src/main.ts' },
      },
      start: { command: 'node dist/main.js' },
      build: { options: { outputPath: 'dist' } },
    },
  });

  // Act + Assert
  ruleTester.run('no-missing-command-executor', rule, {
    valid: [{ code, filename: 'apps/api/project.json' }],
    invalid: [],
  });
});

test('a package.json whose targets are outside the nx key passes, because Nx does not read them', () => {
  // Arrange
  const code = JSON.stringify({
    targets: { serve: { options: { command: 'node src/main.ts' } } },
  });

  // Act + Assert
  ruleTester.run('no-missing-command-executor', rule, {
    valid: [{ code, filename: 'apps/api/package.json' }],
    invalid: [],
  });
});

test('of two targets keys only the last is read, as Nx reads it', () => {
  // Arrange
  const code =
    '{"targets":{"serve":{"options":{"command":"node a.ts"}}},"targets":{"serve":{"executor":"nx:run-commands","options":{"command":"node b.ts"}}}}';

  // Act + Assert
  ruleTester.run('no-missing-command-executor', rule, {
    valid: [{ code, filename: 'apps/api/project.json' }],
    invalid: [],
  });
});
