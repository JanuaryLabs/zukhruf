import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';
import { toolPackages } from './testing/tool-packages.ts';

const execFileAsync = promisify(execFile);

// An Nx workspace in the repo: project b depends on project a through its
// package.json, but b's tsconfig has no reference to a yet, so `nx sync`
// writes one. node_modules links nx, @nx and typescript from zukhruf's
// install. The base commit is made without the hook.
async function workspace(
  folder: string,
  hook: string,
  {
    packages = [],
    gitignore = 'node_modules\n.nx\n',
    nxJson = '{ "plugins": [{ "plugin": "@nx/js/typescript", "options": { "typecheck": { "targetName": "typecheck" } } }] }\n',
    files = {},
  }: {
    readonly packages?: readonly { folder: string; name: string }[];
    readonly gitignore?: string;
    readonly nxJson?: string;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
) {
  const repo = await repository(folder, hook);
  await toolPackages(
    repo.root,
    ['nx', '@nx', 'typescript'],
    [
      { folder: 'packages/a', name: '@probe/a' },
      { folder: 'packages/b', name: '@probe/b' },
      ...packages,
    ],
  );
  await repo.write('.gitignore', gitignore);
  await repo.write(
    'package.json',
    '{ "name": "probe", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
  );
  await repo.write('nx.json', nxJson);
  await repo.write(
    'tsconfig.base.json',
    '{ "compilerOptions": { "composite": true, "module": "NodeNext", "declaration": true } }\n',
  );
  await repo.write(
    'tsconfig.json',
    '{ "extends": "./tsconfig.base.json", "files": [], "references": [{ "path": "./packages/a" }, { "path": "./packages/b" }] }\n',
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
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo.root, path)), { recursive: true });
    await repo.write(path, content);
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

// The workspace plus a sync generator whose input is gitignored generated code,
// as an OpenAPI document derived from a backend needs a generated Prisma
// client: @probe/tools:mirror copies generated/value.txt, which only the
// target @probe/a:produce writes, into the committed mirror.txt, and throws
// when the input is missing.
function workspaceWithGeneratedInput(folder: string, hook: string) {
  return workspace(folder, hook, {
    packages: [{ folder: 'packages/tools', name: '@probe/tools' }],
    gitignore: 'node_modules\n.nx\ngenerated\n',
    nxJson:
      '{ "sync": { "globalGenerators": ["@probe/tools:mirror"] }, "plugins": [{ "plugin": "@nx/js/typescript", "options": { "typecheck": { "targetName": "typecheck" } } }] }\n',
    files: {
      'packages/tools/package.json':
        '{ "name": "@probe/tools", "version": "0.0.0", "generators": "./generators.json" }\n',
      'packages/tools/generators.json':
        '{ "generators": { "mirror": { "factory": "./mirror.cjs", "schema": "./schema.json", "description": "mirror" } } }\n',
      'packages/tools/schema.json': '{ "type": "object" }\n',
      'packages/tools/mirror.cjs': `const { readFileSync } = require('node:fs');
const { join } = require('node:path');
exports.default = async function mirror(tree) {
  const value = readFileSync(join(tree.root, 'generated/value.txt'), 'utf8');
  if (tree.read('mirror.txt', 'utf8') === value) return {};
  tree.write('mirror.txt', value);
  return { outOfSyncMessage: 'mirror.txt is stale' };
};
`,
      'packages/a/produce.mjs': `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('generated', { recursive: true });
writeFileSync('generated/value.txt', 'produced in the snapshot\\n');
`,
      'packages/a/package.json': `${JSON.stringify({ name: '@probe/a', version: '0.0.0', type: 'module', nx: { targets: { produce: { command: 'node packages/a/produce.mjs' } } } })}\n`,
    },
  });
}

test('the sync step runs its before targets in the snapshot before nx sync, so a sync generator whose input is gitignored generated code stages its file', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspaceWithGeneratedInput(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync({ before: ['@probe/a:produce'], stage: ['mirror.txt'] })]);
`,
  );
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', 'HEAD:mirror.txt'),
    'produced in the snapshot\n',
    'The commit must hold what the sync generator wrote from the before target’s output',
  );
  assert.equal(
    await repo.git('ls-files', 'generated'),
    '',
    'The gitignored output of the before target must not be committed',
  );
});

test('a before target that fails stops the commit with the reason the target gave, and nothing is committed', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspaceWithGeneratedInput(
    folder.path,
    `import { Sync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Sync({ before: ['@probe/a:missing-target'], stage: ['mirror.txt'] })]);
`,
  );
  await repo.write('packages/a/src/index.ts', 'export const a = 2;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('change a');

  // Assert
  assert.notEqual(result.code, 0, 'the before target failed');
  assert.match(
    result.stderr,
    /^sync\s+nx run @probe\/a:missing-target exited with \d+/m,
    'The sync step must name the before target that failed',
  );
  assert.equal(
    await repo.git('rev-list', '--count', 'HEAD'),
    '1\n',
    'Only the base commit may exist',
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
