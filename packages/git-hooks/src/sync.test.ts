import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('./index.ts');

// A git repo in a temp folder whose pre-commit hook is `.husky/pre-commit.ts`,
// reached through the committed link `.husky/pre-commit`, as a repo installs
// it. git and the hook see none of the user's git config and no environment
// of the Nx task that runs this test.
async function repository(root: string, hook: string) {
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: root, env: environment })).stdout;
  await git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, '.prettierrc'), '{ "singleQuote": true }\n');
  await mkdir(join(root, '.husky'));
  await writeFile(
    join(root, '.husky/pre-commit.ts'),
    `#!/usr/bin/env node\n${hook.replaceAll('@zukhruf/git-hooks', packageEntry)}`,
  );
  await chmod(join(root, '.husky/pre-commit.ts'), 0o755);
  await symlink('pre-commit.ts', join(root, '.husky/pre-commit'));
  return {
    root,
    git,
    write: (path: string, content: string) =>
      writeFile(join(root, path), content),
    async commit(message: string) {
      try {
        const { stdout, stderr } = await execFileAsync(
          'git',
          ['-c', 'core.hooksPath=.husky', 'commit', '--quiet', '-m', message],
          { cwd: root, env: environment },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          !('stdout' in error) ||
          !('stderr' in error)
        )
          throw error;
        return {
          code: Number(error.code),
          stdout: String(error.stdout),
          stderr: String(error.stderr),
        };
      }
    },
  };
}

const zukhrufModules = new URL('../../../node_modules', import.meta.url)
  .pathname;

// An Nx workspace in the repo: project b depends on project a through its
// package.json, but b's tsconfig has no reference to a yet, so `nx sync`
// writes one. node_modules links to zukhruf's install, which has nx, @nx/js
// and typescript. The base commit is made without the hook.
async function workspace(folder: string, hook: string) {
  const repo = await repository(folder, hook);
  await symlink(zukhrufModules, join(repo.root, 'node_modules'));
  await repo.write('.gitignore', 'node_modules\n.nx\n');
  await repo.write(
    'package.json',
    '{ "name": "probe", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
  );
  await repo.write(
    'nx.json',
    '{ "plugins": [{ "plugin": "@nx/js/typescript", "options": { "typecheck": { "targetName": "typecheck" } } }] }\n',
  );
  await repo.write(
    'tsconfig.base.json',
    '{ "compilerOptions": { "composite": true, "module": "NodeNext", "declaration": true } }\n',
  );
  await repo.write(
    'tsconfig.json',
    '{ "files": [], "references": [{ "path": "./packages/a" }, { "path": "./packages/b" }] }\n',
  );
  for (const [name, dependencies] of [
    ['a', {}],
    ['b', { '@probe/a': '*' }],
  ] as const) {
    await mkdir(join(repo.root, `packages/${name}/src`), { recursive: true });
    await repo.write(
      `packages/${name}/package.json`,
      `${JSON.stringify({ name: `@probe/${name}`, version: '0.0.0', type: 'module', dependencies })}\n`,
    );
    await repo.write(
      `packages/${name}/tsconfig.json`,
      '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src/**/*.ts"] }\n',
    );
    await repo.write(
      `packages/${name}/src/index.ts`,
      `export const ${name} = 1;\n`,
    );
  }
  await repo.git('add', '--all');
  await repo.git('commit', '--quiet', '--no-verify', '-m', 'base');
  return repo;
}

test('the sync step stages the tsconfig that nx sync rewrote, so the commit holds the new project reference', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync()]);
`,
  );
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', '--name-only', '--format=', 'HEAD'),
    'packages/a/src/index.ts\npackages/b/tsconfig.json\n',
    'The commit must hold the staged file and the tsconfig that nx sync wrote',
  );
  assert.match(
    await repo.git('show', 'HEAD:packages/b/tsconfig.json'),
    /"path": "\.\.\/a"/,
    'The committed tsconfig must reference project a',
  );
});

test('the sync step never stages a file that was modified before the hook ran, even when nx sync rewrites it', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync()]);
`,
  );
  const base = await repo.git('show', 'HEAD:packages/b/tsconfig.json');
  // Another session edits b's tsconfig and has not staged it.
  await repo.write(
    'packages/b/tsconfig.json',
    '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist", "strict": true }, "include": ["src/**/*.ts"] }\n',
  );
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', 'HEAD:packages/b/tsconfig.json'),
    base,
    "The commit must not take the other session's tsconfig edit",
  );
  const working = await readFile(
    join(repo.root, 'packages/b/tsconfig.json'),
    'utf8',
  );
  assert.match(
    working,
    /"path": "\.\.\/a"/,
    'nx sync must have rewritten the edited tsconfig',
  );
  assert.match(
    working,
    /"strict": true/,
    "The other session's edit stays in the working tree",
  );
  assert.equal(
    await repo.git('status', '--porcelain', '--', 'packages/b/tsconfig.json'),
    ' M packages/b/tsconfig.json\n',
    'The edited tsconfig stays modified and unstaged',
  );
});

test('the sync step stages only files that match its globs: a file nx sync wrote outside them stays unstaged', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync({ stage: ['**/styles.css'] })]);
`,
  );
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', '--name-only', '--format=', 'HEAD'),
    'packages/a/src/index.ts\n',
    'The commit must not hold the tsconfig, which the globs do not name',
  );
  assert.equal(
    await repo.git('status', '--porcelain', '--', 'packages/b/tsconfig.json'),
    ' M packages/b/tsconfig.json\n',
    'nx sync still wrote the tsconfig, and it stays unstaged',
  );
});

test('an nx sync that fails stops the commit with the reason nx gave, and nothing is committed', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync()]);
`,
  );
  await repo.write('nx.json', '{ "plugins": ["./tools/missing-plugin.js"] }\n');
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.notEqual(result.code, 0, 'nx sync failed');
  assert.match(
    result.stderr,
    /^sync\s+\S/m,
    'The sync step must give the failure as its outcome',
  );
  assert.match(
    result.stderr,
    /missing-plugin\.js/,
    'The hook must show the reason nx gave',
  );
  assert.doesNotMatch(
    result.stderr,
    /node:internal/,
    'The hook must not crash with a stack trace',
  );
  assert.equal(
    await repo.git('rev-list', '--count', 'HEAD'),
    '1\n',
    'Only the base commit may exist',
  );
});
