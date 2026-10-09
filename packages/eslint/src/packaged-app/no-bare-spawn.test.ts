import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { typescriptRuleTester } from '../testing/rule-tester.ts';
import rule from './no-bare-spawn.ts';

const ROOTS = [{ roots: ['packages/sources', 'apps/desktop/src/main'] }];

test('no-bare-spawn', () => {
  using workspace = fixtureWorkspace({ 'nx.json': '{}' });
  const inScope = workspace.path('packages/sources/postgres/src/x.ts');

  typescriptRuleTester().run('no-bare-spawn', rule, {
    valid: [
      // An absolute path never consults PATH.
      {
        code: `import spawn from 'nano-spawn';
const run = (args: string[], signal: AbortSignal) => spawn('/usr/bin/plutil', args, { signal });`,
        filename: inScope,
        options: ROOTS,
      },
      // A variable command is the caller's contract, not this rule's concern.
      {
        code: `import spawn from 'nano-spawn';
const run = (file: string, args: string[]) => spawn(file, args);`,
        filename: inScope,
        options: ROOTS,
      },
      // Out of the configured roots: dev tooling may use PATH freely.
      {
        code: `import spawn from 'nano-spawn';
await spawn('docker', ['ps']);`,
        filename: workspace.path('tools/scripts/dev-helper.ts'),
        options: ROOTS,
      },
      // Roots are workspace-relative: the same folder names nested elsewhere
      // are out of scope.
      {
        code: `import spawn from 'nano-spawn';
await spawn('docker', ['ps']);`,
        filename: workspace.path('tools/packages/sources/x.ts'),
        options: ROOTS,
      },
      // Inside the roots, a test file is still skipped.
      {
        code: `import spawn from 'nano-spawn';
await spawn('docker', ['ps']);`,
        filename: workspace.path('packages/sources/postgres/src/x.test.ts'),
        options: ROOTS,
      },
      // A JavaScript test file is a test file too.
      {
        code: `import spawn from 'nano-spawn';
await spawn('docker', ['ps']);`,
        filename: workspace.path('packages/sources/postgres/src/x.spec.mjs'),
        options: ROOTS,
      },
      // A user-defined function named spawn is not a subprocess.
      {
        code: `const spawn = (name: string) => name;
spawn('docker');`,
        filename: inScope,
        options: ROOTS,
      },
    ],
    invalid: [
      // Docker discovery dead in every packaged build: launchd's PATH has no
      // docker.
      {
        code: `import spawn from 'nano-spawn';
const runDockerCommand = (args: readonly string[], signal: AbortSignal) =>
  spawn('docker', [...args], { signal });`,
        filename: inScope,
        options: ROOTS,
        errors: [{ messageId: 'noBareSpawn', data: { command: 'docker' } }],
      },
      // `npx` is a PATH lookup too.
      {
        code: `import { execFile } from 'node:child_process';
execFile('npx', ['prisma', 'migrate', 'deploy']);`,
        filename: workspace.path('apps/desktop/src/main/x.ts'),
        options: ROOTS,
        errors: [{ messageId: 'noBareSpawn', data: { command: 'npx' } }],
      },
      // exec-style shell strings: the first token is the PATH-resolved binary.
      {
        code: `import * as cp from 'node:child_process';
cp.execSync('docker ps --quiet');`,
        filename: inScope,
        options: ROOTS,
        errors: [{ messageId: 'noBareSpawn', data: { command: 'docker' } }],
      },
      // Renaming the import must not evade the rule.
      {
        code: `import { spawn as launch } from 'child_process';
launch(\`docker\`, ['ps']);`,
        filename: inScope,
        options: ROOTS,
        errors: [{ messageId: 'noBareSpawn', data: { command: 'docker' } }],
      },
    ],
  });
});
