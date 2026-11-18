import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-cross-project-paths.ts';

const ruleTester = jsonRuleTester();

const WORKSPACE = {
  'nx.json': '{}',
  'package.json': JSON.stringify({ name: '@acme/source', private: true }),
  'packages/api/package.json': JSON.stringify({ name: '@acme/api' }),
  'packages/ui/project.json': JSON.stringify({ name: 'ui' }),
  'packages/ui/src/index.ts': '',
};

function tsconfig(compilerOptions: Record<string, unknown>): string {
  return JSON.stringify({ compilerOptions });
}

test('a project tsconfig with an alias into another project is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(WORKSPACE);
  const code = tsconfig({ paths: { '@acme/ui/*': ['../ui/src/*'] } });

  // Act + Assert
  ruleTester.run('no-cross-project-paths', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('packages/api/tsconfig.json'),
        errors: [
          {
            messageId: 'crossProject',
            data: {
              alias: '@acme/ui/*',
              target: '../ui/src/*',
              project: 'packages/ui',
            },
          },
        ],
      },
    ],
  });
});

test('the root tsconfig.base.json with an alias to a project is reported, with comments as tsconfig allows', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(WORKSPACE);
  const code = `{
    // TypeScript reads comments in a tsconfig.
    "compilerOptions": {
      "paths": { "@acme/ui": ["packages/ui/src/index.ts"] },
    },
  }`;

  // Act + Assert
  ruleTester.run('no-cross-project-paths', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('tsconfig.base.json'),
        errors: [
          {
            messageId: 'crossProject',
            data: {
              alias: '@acme/ui',
              target: 'packages/ui/src/index.ts',
              project: 'packages/ui',
            },
          },
        ],
      },
    ],
  });
});

test('a target resolves from baseUrl when the tsconfig sets it, also to a project folder itself', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(WORKSPACE);
  const code = tsconfig({
    baseUrl: '../..',
    paths: { '@acme/ui': ['packages/ui'], '#own/*': ['packages/api/src/*'] },
  });

  // Act + Assert
  ruleTester.run('no-cross-project-paths', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('packages/api/tsconfig.lib.json'),
        errors: [
          {
            messageId: 'crossProject',
            data: {
              alias: '@acme/ui',
              target: 'packages/ui',
              project: 'packages/ui',
            },
          },
        ],
      },
    ],
  });
});

test('an alias inside the project or into node_modules passes', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(WORKSPACE);
  const code = tsconfig({
    paths: {
      '#components/*': ['./src/components/*'],
      '#lib/*': ['src/lib/*'],
      react: ['../../node_modules/@types/react'],
    },
  });
  const withBaseUrl = tsconfig({ baseUrl: 'src', paths: { '#x/*': ['x/*'] } });

  // Act + Assert
  ruleTester.run('no-cross-project-paths', rule, {
    valid: [
      { code, filename: workspace.path('packages/api/tsconfig.json') },
      {
        code: withBaseUrl,
        filename: workspace.path('packages/api/tsconfig.json'),
      },
      { code: tsconfig({}), filename: workspace.path('tsconfig.base.json') },
    ],
    invalid: [],
  });
});
