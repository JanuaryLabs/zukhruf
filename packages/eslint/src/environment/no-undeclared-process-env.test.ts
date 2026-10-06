import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-undeclared-process-env.ts';

const ruleTester = typescriptRuleTester();

/**
 * The rule parses a real startup file off disk, so each case writes its own
 * fixture. A fresh temp directory per test also sidesteps the module-level
 * startup cache, which is keyed by absolute path and mtime.
 */
test('no-undeclared-process-env accepts keys declared in the startup schema', () => {
  using workspace = fixtureWorkspace({
    'startup.ts':
      'const env = z.object({ DATABASE_URL: z.string(), PORT: z.string() });\n',
  });
  const startupFile = workspace.path('startup.ts');
  const filename = workspace.path('server.ts');

  ruleTester.run('no-undeclared-process-env', rule, {
    valid: [
      {
        code: 'const url = process.env.DATABASE_URL;',
        filename,
        options: [{ startupFile }],
      },
      {
        // Computed access resolves to the same key and is equally declared.
        code: "const port = process.env['PORT'];",
        filename,
        options: [{ startupFile }],
      },
      {
        // Not process.env at all — a same-named property on another object.
        code: 'const value = config.env.ANYTHING;',
        filename,
        options: [{ startupFile }],
      },
    ],
    invalid: [
      {
        code: 'const secret = process.env.SECRET_KEY;',
        filename,
        options: [{ startupFile }],
        errors: [{ messageId: 'undeclaredEnv' }],
      },
      {
        code: "const secret = process.env['SECRET_KEY'];",
        filename,
        options: [{ startupFile }],
        errors: [{ messageId: 'undeclaredEnv' }],
      },
    ],
  });
});

test('no-undeclared-process-env reports once when the startup schema is unreadable', () => {
  using workspace = fixtureWorkspace({});

  ruleTester.run('no-undeclared-process-env', rule, {
    valid: [],
    invalid: [
      {
        // Two accesses, one diagnostic: an unreadable schema is one problem
        // with the setup, not one problem per usage site.
        code: 'const a = process.env.ONE;\nconst b = process.env.TWO;',
        filename: workspace.path('server.ts'),
        options: [{ startupFile: workspace.path('startup.ts') }],
        errors: [{ messageId: 'startupUnavailable' }],
      },
    ],
  });
});

test('no-undeclared-process-env reports when the startup file has no env schema', () => {
  using workspace = fixtureWorkspace({
    'startup.ts': 'export const unrelated = 1;\n',
  });

  ruleTester.run('no-undeclared-process-env', rule, {
    valid: [],
    invalid: [
      {
        // A startup file that parses but declares nothing must not read as
        // "zero declared keys, so everything is undeclared" — it is a setup
        // failure, and the message has to say so.
        code: 'const a = process.env.ONE;',
        filename: workspace.path('server.ts'),
        options: [{ startupFile: workspace.path('startup.ts') }],
        errors: [{ messageId: 'startupUnavailable' }],
      },
    ],
  });
});

test('no-undeclared-process-env reads the default startup file from the project of the linted file, not the working directory', () => {
  // The test process runs from packages/eslint, outside this workspace, as an
  // editor runs ESLint from the workspace root rather than the project.
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'apps/api/project.json': '{}',
    'apps/api/src/startup.ts':
      'const env = z.object({ DATABASE_URL: z.string() });\n',
  });
  const filename = workspace.path('apps/api/src/routes/server.ts');

  ruleTester.run('no-undeclared-process-env', rule, {
    valid: [{ code: 'const url = process.env.DATABASE_URL;', filename }],
    invalid: [
      {
        code: 'const secret = process.env.SECRET_KEY;',
        filename,
        errors: [
          {
            messageId: 'undeclaredEnv',
            // Named relative to the workspace root, wherever ESLint runs.
            data: {
              key: 'SECRET_KEY',
              startupFile: 'apps/api/src/startup.ts',
            },
          },
        ],
      },
    ],
  });
});
