import { test } from 'node:test';

import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-depends-on-project.ts';

const ruleTester = jsonRuleTester();

test('a dependsOn entry that names projects by name, glob or tag is reported', () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      build: {
        executor: '@nx/esbuild:esbuild',
        dependsOn: [
          { projects: ['shared-ui'], target: 'build' },
          { projects: 'database', target: 'generate' },
          { projects: ['packages/*', 'tag:scope:api'], target: 'build' },
        ],
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-depends-on-project', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'apps/api/project.json',
        errors: [
          { messageId: 'namedProject', data: { target: 'build' } },
          { messageId: 'namedProject', data: { target: 'build' } },
          { messageId: 'namedProject', data: { target: 'build' } },
        ],
      },
    ],
  });
});

test('a dependsOn entry that names a project in the nx key of a package.json is reported', () => {
  // Arrange
  const code = JSON.stringify({
    name: '@acme/web',
    nx: {
      targets: {
        serve: { dependsOn: [{ projects: ['api'], target: 'serve' }] },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-depends-on-project', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: 'apps/web/package.json',
        errors: [{ messageId: 'namedProject', data: { target: 'serve' } }],
      },
    ],
  });
});

test('a dependsOn that follows the import graph or stays in the project passes', () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      build: {
        dependsOn: [
          '^build',
          'generate',
          { target: 'build', dependencies: true },
          { target: 'codegen' },
          { projects: 'self', target: 'lint' },
          { projects: 'dependencies', target: 'build' },
          { projects: [], target: 'build' },
        ],
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-depends-on-project', rule, {
    valid: [{ code, filename: 'apps/api/project.json' }],
    invalid: [],
  });
});

test('a string with a colon passes, because it can be the name of a target such as format:check', () => {
  // Arrange
  const code = JSON.stringify({
    targets: { typecheck: { dependsOn: ['lint', 'format:check'] } },
  });

  // Act + Assert
  ruleTester.run('no-depends-on-project', rule, {
    valid: [{ code, filename: 'packages/lib/project.json' }],
    invalid: [],
  });
});
