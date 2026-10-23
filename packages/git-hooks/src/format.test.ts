import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('./index.ts');

// A git repo in a temp folder whose pre-commit hook is `.husky/pre-commit.ts`,
// reached through the committed link `.husky/pre-commit`, as a repo installs
// it. git and the hook see none of the user's git config and no environment
// of the Nx task that runs this test.
async function repository(folder: string, hook: string) {
  const root = await realpath(folder);
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

const formatOnly = `import { Format, preCommit } from '@zukhruf/git-hooks';
await preCommit([new Format()]);
`;

test('a commit whose staged files are not formatted is stopped, and the hook lists every one of them with the command that formats them', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('a.ts', 'const a=1\n');
  await repo.write('b.ts', 'let b={x:1}\n');
  await repo.git('add', 'a.ts', 'b.ts');

  // Act
  const result = await repo.commit('unformatted');

  // Assert
  assert.notEqual(result.code, 0, 'The hook must stop the commit');
  assert.match(result.stderr, /\ba\.ts\b/, 'The hook must name a.ts');
  assert.match(result.stderr, /\bb\.ts\b/, 'The hook must name b.ts');
  assert.match(
    result.stderr,
    /Run `npx prettier --write a\.ts b\.ts`/,
    'The hook must give the command that formats the files',
  );
  assert.equal(
    await repo.git('rev-list', '--all', '--count').catch(() => '0\n'),
    '0\n',
    'No commit may exist',
  );
});

test('a partially staged file is judged by its staged copy: an unformatted staged copy stops the commit even when the working tree is formatted', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('a.ts', 'const a=1\n');
  await repo.git('add', 'a.ts');
  await repo.write('a.ts', 'const a = 1;\n');

  // Act
  const result = await repo.commit('staged copy unformatted');

  // Assert
  assert.notEqual(result.code, 0, 'The staged copy is unformatted');
  assert.match(result.stderr, /\ba\.ts\b/, 'The hook must name a.ts');
});

test('a partially staged file is judged by its staged copy: a formatted staged copy passes even when unstaged edits are unformatted', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('a.ts', 'const a = 1;\n');
  await repo.git('add', 'a.ts');
  await repo.write('a.ts', 'const a=1\n');

  // Act
  const result = await repo.commit('staged copy formatted');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', 'HEAD:a.ts'),
    'const a = 1;\n',
    'The commit must hold the staged copy',
  );
});

test('the hook rewrites no file and stages nothing: unstaged edits stay unstaged, and a stopped commit leaves the index as it was', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('peer.ts', 'const peer = 1;\n');
  await repo.git('add', 'peer.ts');
  await repo.git('commit', '--quiet', '--no-verify', '-m', 'base');
  await repo.write('peer.ts', 'const peer=2\n');
  await repo.write('mine.ts', 'const mine = 1;\n');
  await repo.git('add', 'mine.ts');

  // Act
  const passed = await repo.commit('formatted');
  await repo.write('bad.ts', 'const bad=1\n');
  await repo.git('add', 'bad.ts');
  const indexBefore = await repo.git('ls-files', '--stage');
  const stopped = await repo.commit('unformatted');

  // Assert
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(
    await repo.git('show', '--name-only', '--format=', 'HEAD'),
    'mine.ts\n',
    "The commit must hold only the staged file, not the peer's unstaged edit",
  );
  assert.notEqual(stopped.code, 0, 'bad.ts is unformatted');
  assert.equal(
    await repo.git('ls-files', '--stage'),
    indexBefore,
    'A stopped commit must leave the index as it was',
  );
  assert.equal(
    await repo.git('status', '--porcelain', '--', 'peer.ts', 'bad.ts'),
    'A  bad.ts\n M peer.ts\n',
    'bad.ts stays staged unformatted, and peer.ts stays modified and unstaged',
  );
  assert.equal(
    await repo
      .git('diff', '--', 'peer.ts')
      .then((diff) => diff.includes('+const peer=2')),
    true,
    "The hook must not rewrite the peer's working-tree edit",
  );
});

test('a staged file that Prettier cannot parse stops the commit and is listed with its error, and the other staged files are still checked', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('broken.ts', 'const = ;\n');
  await repo.write('unformatted.ts', 'const a=1\n');
  await repo.git('add', 'broken.ts', 'unformatted.ts');

  // Act
  const result = await repo.commit('broken');

  // Assert
  assert.notEqual(result.code, 0, 'broken.ts cannot be parsed');
  assert.match(
    result.stderr,
    /broken\.ts \(SyntaxError/,
    'The hook must list broken.ts with the error Prettier gave',
  );
  assert.match(
    result.stderr,
    /\bunformatted\.ts\b/,
    'The hook must still check and list the other staged files',
  );
  assert.doesNotMatch(
    result.stderr,
    /\n\s+at /,
    'The hook must not crash with a stack trace',
  );
});

test('files that .prettierignore names and files that Prettier has no parser for do not stop the commit', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('.prettierignore', 'generated.ts\n');
  await repo.write('generated.ts', 'const g=1\n');
  await repo.write('LICENSE', 'MIT   License\n');
  await repo.write('image.bin', '\u0000\u0001binary');
  await repo.git(
    'add',
    '.prettierignore',
    'generated.ts',
    'LICENSE',
    'image.bin',
  );

  // Act
  const result = await repo.commit('ignored and unknown');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('a staged file larger than 1 MiB is read and checked', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write(
    'large.md',
    `# Notes\n\n${'A formatted line.\n\n'.repeat(70_000)}`.trimEnd() + '\n',
  );
  await repo.write(
    'large.ts',
    `${'const value = 1;\n'.repeat(80_000)}const a=1\n`,
  );
  await repo.git('add', 'large.md', 'large.ts');

  // Act
  const result = await repo.commit('large');

  // Assert
  assert.notEqual(result.code, 0, 'large.ts ends with an unformatted line');
  assert.match(
    result.stderr,
    /\blarge\.ts\b/,
    'The hook must read and check large.ts',
  );
  assert.doesNotMatch(result.stderr, /large\.md/, 'large.md is formatted');
});

test("the repo's own .prettierrc decides: a file formatted only under Prettier's defaults stops the commit, and a file formatted under the repo's config passes", async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('single.ts', "const a = 'x';\n");
  await repo.git('add', 'single.ts');

  // Act
  const passed = await repo.commit('single quotes, as the repo asks');
  await repo.write('double.ts', 'const b = "x";\n');
  await repo.git('add', 'double.ts');
  const stopped = await repo.commit("double quotes, Prettier's default");

  // Assert
  assert.equal(passed.code, 0, passed.stderr);
  assert.notEqual(stopped.code, 0, 'The repo asks for single quotes');
  assert.match(
    stopped.stderr,
    /\bdouble\.ts\b/,
    'The hook must name double.ts',
  );
});

test('a commit whose staged files are formatted is made, and the hook says what the step checked', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('a.ts', 'const a = 1;\n');
  await repo.git('add', 'a.ts');

  // Act
  const result = await repo.commit('formatted');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stderr,
    /^format\s+\S/m,
    "The hook must print the format step's outcome",
  );
  assert.equal(
    await repo.git('rev-list', '--count', 'HEAD'),
    '1\n',
    'The commit must exist',
  );
});

test('a commit that deletes a file is made: a deleted file has no staged copy to check', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  await repo.write('old.ts', 'const old = 1;\n');
  await repo.git('add', 'old.ts');
  await repo.git('commit', '--quiet', '--no-verify', '-m', 'base');
  await repo.git('rm', '--quiet', 'old.ts');

  // Act
  const result = await repo.commit('delete old.ts');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('show', '--name-status', '--format=', 'HEAD'),
    'D\told.ts\n',
    'The commit must delete old.ts',
  );
});

const packageRoot = new URL('..', import.meta.url).pathname;
const zukhrufModules = new URL('../../../node_modules', import.meta.url)
  .pathname;

test('a repo that installs the packed package runs a hook that imports it by name', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  await using packed = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(folder.path, formatOnly);
  // The hook as a repo writes it: the package by name, from node_modules.
  await repo.write(
    '.husky/pre-commit.ts',
    `#!/usr/bin/env node\n${formatOnly}`,
  );
  // npm pack gives the files that npm publish uploads, and the repo's own
  // Prettier is the peer dependency.
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', `--pack-destination=${packed.path}`],
    { cwd: packageRoot },
  );
  const installed = join(repo.root, 'node_modules/@zukhruf/git-hooks');
  await mkdir(installed, { recursive: true });
  await execFileAsync('tar', [
    '-xzf',
    join(packed.path, stdout.trim()),
    '-C',
    installed,
    '--strip-components=1',
  ]);
  await symlink(
    join(zukhrufModules, 'prettier'),
    join(repo.root, 'node_modules/prettier'),
  );
  await repo.write('a.ts', 'const a=1\n');
  await repo.git('add', 'a.ts');

  // Act
  const result = await repo.commit('unformatted');

  // Assert
  assert.notEqual(result.code, 0, 'a.ts is unformatted');
  assert.match(
    result.stderr,
    /are not formatted:\n\s+a\.ts$/m,
    'The installed package must run the format step and list a.ts',
  );
});
