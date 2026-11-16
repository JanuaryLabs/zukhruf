import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Commit } from '@zukhruf/git-hooks';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { ReadmeTable } from './readme-table-step.ts';

const readme = `# workspace

<!-- packages-table:start -->

<!-- packages-table:end -->
`;

function run(script: 'check.ts' | 'generate.ts', workspace: string) {
  return spawnSync(
    process.execPath,
    ['--no-warnings', fileURLToPath(new URL(script, import.meta.url))],
    { cwd: workspace, encoding: 'utf8' },
  );
}

function git(workspace: string, ...args: string[]) {
  const { status, stderr } = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  assert.equal(status, 0, stderr);
}

async function write(workspace: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), content);
  }
}

test('a staged package with no row fails the check, and says how to fix it', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }),
    'packages/queue/package.json': JSON.stringify({
      name: '@x/queue',
      description: 'Jobs that wait their turn.',
    }),
    'README.md': readme,
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', '.');

  // Act
  const { status, stderr } = run('check.ts', workspace.path);

  // Assert
  assert.equal(status, 1);
  assert.match(stderr, /npx nx run readme-table:generate/);
});

test('generate writes one row for each staged package, sorted by name, from its description, and the check then passes', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({
      workspaces: ['packages/*', 'packages/sqlite/*', 'apps/*'],
    }),
    'packages/queue/package.json': JSON.stringify({
      name: '@x/queue',
      description: 'Jobs that wait their turn.',
    }),
    'packages/sqlite/open/package.json': JSON.stringify({
      name: '@x/open',
      description: 'One open for each connection.',
      private: true,
    }),
    'apps/site/package.json': JSON.stringify({
      name: '@x/site',
      description: 'The web site.',
    }),
    'README.md': readme,
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', '.');

  // Act
  const generate = run('generate.ts', workspace.path);
  git(workspace.path, 'add', 'README.md');
  const check = run('check.ts', workspace.path);

  // Assert
  assert.equal(generate.status, 0, generate.stderr);
  assert.equal(check.status, 0, check.stderr);
  const rows = (await readFile(join(workspace.path, 'README.md'), 'utf8'))
    .split('\n')
    .filter((line) => line.startsWith('| ['))
    .map((line) => line.replaceAll(/\s+/g, ' '));
  assert.deepStrictEqual(rows, [
    '| [`@x/open`](./packages/sqlite/open) | One open for each connection. Private: reached through a workspace path. |',
    '| [`@x/queue`](./packages/queue) | Jobs that wait their turn. |',
  ]);
});

test('a package that is on disk but not staged gets no row', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/queue/package.json': JSON.stringify({
      name: '@x/queue',
      description: 'Jobs that wait their turn.',
    }),
    'README.md': readme,
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', '.');
  await write(workspace.path, {
    'packages/draft/package.json': JSON.stringify({
      name: '@x/draft',
      description: 'Another session is still writing this one.',
    }),
  });

  // Act
  const { status, stderr } = run('generate.ts', workspace.path);

  // Assert
  assert.equal(status, 0, stderr);
  const generated = await readFile(join(workspace.path, 'README.md'), 'utf8');
  assert.match(generated, /@x\/queue/);
  assert.doesNotMatch(generated, /@x\/draft/);
});

test('a staged package.json with no description stops generate, and names the file', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/queue/package.json': JSON.stringify({ name: '@x/queue' }),
    'README.md': readme,
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', '.');

  // Act
  const { status, stderr } = run('generate.ts', workspace.path);

  // Assert
  assert.notEqual(status, 0);
  assert.match(
    stderr,
    /packages\/queue\/package\.json needs a name and a description/,
  );
});

test('the pre-commit step skips a commit that stages no package.json and no README', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'README.md': readme,
    'notes.txt': 'Not a package.',
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', 'notes.txt');

  // Act
  const outcome = await new ReadmeTable().run(
    new Commit({ root: workspace.path, environment: process.env }),
  );

  // Assert
  assert.equal(outcome.kind, 'skip');
});

test('the pre-commit step fails a commit whose staged README has no row for a staged package', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/queue/package.json': JSON.stringify({
      name: '@x/queue',
      description: 'Jobs that wait their turn.',
    }),
    'README.md': readme,
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', '.');

  // Act
  const outcome = await new ReadmeTable().run(
    new Commit({ root: workspace.path, environment: process.env }),
  );

  // Assert
  assert.equal(outcome.kind, 'fail');
  assert.match(outcome.message, /npx nx run readme-table:generate/);
});

test('the pre-commit step passes a commit whose staged README holds the generated table', async () => {
  // Arrange
  await using workspace = await new TemporaryFiles().directory('readme-table-');
  await write(workspace.path, {
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/queue/package.json': JSON.stringify({
      name: '@x/queue',
      description: 'Jobs that wait their turn.',
    }),
    'README.md': readme,
  });
  git(workspace.path, 'init', '-q');
  git(workspace.path, 'add', '.');
  assert.equal(run('generate.ts', workspace.path).status, 0);
  git(workspace.path, 'add', 'README.md');

  // Act
  const outcome = await new ReadmeTable().run(
    new Commit({ root: workspace.path, environment: process.env }),
  );

  // Assert
  assert.equal(outcome.kind, 'pass');
});
