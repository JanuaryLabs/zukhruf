import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { nxPackages } from './testing/nx-packages.ts';
import { repository } from './testing/pre-commit-repository.ts';

const execFileAsync = promisify(execFile);

// An Nx workspace in the repo: project b depends on project a through its
// package.json, but b's tsconfig has no reference to a yet, so `nx sync`
// writes one. node_modules links nx, @nx and typescript from zukhruf's
// install. The base commit is made without the hook.
async function workspace(folder: string, hook: string) {
  const repo = await repository(folder, hook);
  await nxPackages(repo.root, [
    { folder: 'packages/a', name: '@probe/a' },
    { folder: 'packages/b', name: '@probe/b' },
  ]);
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

test("the sync step syncs the staged copy of a file that another session edits: the commit holds the synced staged copy, and the other session's working copy stays as it is", async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync()]);
`,
  );
  // Another session edits b's tsconfig and has not staged it.
  const edited =
    '{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist", "strict": true }, "include": ["src/**/*.ts"] }\n';
  await repo.write('packages/b/tsconfig.json', edited);
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const committed = await repo.git('show', 'HEAD:packages/b/tsconfig.json');
  assert.match(
    committed,
    /"path": "\.\.\/a"/,
    'The commit must hold the synced staged copy, with the reference to a',
  );
  assert.doesNotMatch(
    committed,
    /"strict"/,
    "The commit must not take the other session's edit",
  );
  assert.equal(
    await readFile(join(repo.root, 'packages/b/tsconfig.json'), 'utf8'),
    edited,
    "The other session's working copy must stay as it was",
  );
  assert.match(
    result.stderr,
    /^sync\s+left the working-tree copy of packages\/b\/tsconfig\.json: it has edits that are not staged$/m,
  );
});

test('the sync step stages only files that match its globs: a file nx sync wrote outside them reaches neither the commit nor the working tree', async () => {
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
    '',
    'nx sync wrote the tsconfig in its snapshot only, so the working tree keeps the committed copy',
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
  // The commit itself names a plugin that does not exist.
  await repo.write('nx.json', '{ "plugins": ["./tools/missing-plugin.js"] }\n');
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'nx.json', 'packages/a/src/index.ts');

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
