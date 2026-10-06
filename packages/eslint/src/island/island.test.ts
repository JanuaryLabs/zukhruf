import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typescriptRuleTester } from '../testing/rule-tester.ts';
import plugin from './plugin.ts';

const workspaceFiles = {
  'nx.json': '{}',
  'packages/island/project.json': JSON.stringify({ tags: ['layer:island'] }),
  'packages/island/src/index.ts': '',
  'packages/library/project.json': JSON.stringify({ tags: [] }),
  'packages/library/src/index.ts': '',
  'apps/host/project.json': JSON.stringify({ tags: ['scope:app'] }),
  'apps/host/src/main.ts': '',
};

test('island/no-console reports console in islands and in library globs, not in hosts', () => {
  using workspace = fixtureWorkspace(workspaceFiles);
  const libraries = { island: { libraries: ['packages/library/**/*.ts'] } };

  typescriptRuleTester().run('no-console', plugin.rules['no-console'], {
    valid: [
      {
        code: `console.log('started');`,
        filename: workspace.path('apps/host/src/main.ts'),
        settings: libraries,
      },
      // A local binding named console is not the global.
      {
        code: `const console = logger(); console.log('x');`,
        filename: workspace.path('packages/island/src/index.ts'),
      },
    ],
    invalid: [
      {
        code: `console.log('x');`,
        filename: workspace.path('packages/island/src/index.ts'),
        errors: [{ messageId: 'console' }],
      },
      {
        code: `console.error('x');`,
        filename: workspace.path('packages/library/src/index.ts'),
        settings: libraries,
        errors: [{ messageId: 'console' }],
      },
    ],
  });
});

test('island/no-process-env reports both read forms in islands only', () => {
  using workspace = fixtureWorkspace(workspaceFiles);
  const island = workspace.path('packages/island/src/index.ts');

  typescriptRuleTester().run('no-process-env', plugin.rules['no-process-env'], {
    valid: [
      {
        code: `const port = process.env.PORT;`,
        filename: workspace.path('apps/host/src/main.ts'),
      },
      { code: `const cwd = process.cwd();`, filename: island },
    ],
    invalid: [
      {
        code: `const port = process.env.PORT;`,
        filename: island,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `const port = process['env'].PORT;`,
        filename: island,
        errors: [{ messageId: 'matched' }],
      },
      {
        code: `const { env } = process;`,
        filename: island,
        errors: [{ messageId: 'matched' }],
      },
    ],
  });
});

test('island/no-generic-port reports generic port methods in islands only', () => {
  using workspace = fixtureWorkspace(workspaceFiles);
  const island = workspace.path('packages/island/src/index.ts');

  typescriptRuleTester().run(
    'no-generic-port',
    plugin.rules['no-generic-port'],
    {
      valid: [
        {
          code: `interface Store { get(key: string): Promise<unknown>; }`,
          filename: island,
        },
        {
          code: `interface Store { get<T>(key: string): Promise<T>; }`,
          filename: workspace.path('apps/host/src/main.ts'),
        },
      ],
      invalid: [
        {
          code: `interface Store { get<T>(key: string): Promise<T>; }`,
          filename: island,
          errors: [{ messageId: 'matched' }],
        },
        {
          code: `type Fetch = <T>(url: string) => Promise<T>;`,
          filename: island,
          errors: [{ messageId: 'matched' }],
        },
      ],
    },
  );
});

test('island/no-explicit-any reuses typescript-eslint and applies to islands only', () => {
  using workspace = fixtureWorkspace(workspaceFiles);

  typescriptRuleTester().run(
    'no-explicit-any',
    plugin.rules['no-explicit-any'],
    {
      valid: [
        {
          code: `const x: any = 1;`,
          filename: workspace.path('apps/host/src/main.ts'),
        },
      ],
      invalid: [
        {
          code: `const x: any = 1;`,
          filename: workspace.path('packages/island/src/index.ts'),
          errors: [
            {
              messageId: 'unexpectedAny',
              suggestions: [
                {
                  messageId: 'suggestUnknown',
                  output: `const x: unknown = 1;`,
                },
                { messageId: 'suggestNever', output: `const x: never = 1;` },
              ],
            },
          ],
        },
      ],
    },
  );
});
