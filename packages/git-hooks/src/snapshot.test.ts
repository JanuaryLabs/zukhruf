import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import type { Commit } from './index.ts';
import { hookedGit, isolatedEnvironment } from './testing/hooked-repository.ts';
import { repository } from './testing/pre-commit-repository.ts';

// A tool that gives the environment that it got, as JSON on its standard
// output.
const printEnvironment =
  '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.env));\n';

// A repo whose staged commit has a lockfile with no dependency, and whose
// node_modules is an install of it with one tool in .bin, `printenv`. The
// snapshot then uses the packages of the repo.
async function installedRepository(root: string, hook: string) {
  const repo = await repository(root, hook);
  await repo.write('.gitignore', 'node_modules\n');
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({ name: 'probe', lockfileVersion: 3, requires: true, packages: { '': { name: 'probe' } } })}\n`,
  );
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  await repo.write(
    'node_modules/.package-lock.json',
    `${JSON.stringify({ name: 'probe', lockfileVersion: 3, requires: true, packages: {} })}\n`,
  );
  await repo.write('node_modules/.bin/printenv', printEnvironment);
  await chmod(join(root, 'node_modules/.bin/printenv'), 0o755);
  await repo.git('add', '.gitignore', 'package.json', 'package-lock.json');
  return repo;
}

// The hook environment without each variable that git lists as tied to the
// repo, as git itself gives the list.
async function withoutLocalEnvVars(
  git: (...args: string[]) => Promise<string>,
  hook: Readonly<Record<string, unknown>>,
) {
  const names = new Set(
    (await git('rev-parse', '--local-env-vars')).split('\n'),
  );
  return Object.fromEntries(
    Object.entries(hook).filter(([name]) => !names.has(name)),
  );
}

// What a step printed on its outcome line, as JSON.
function printed(stderr: string, step: string): Record<string, unknown> {
  const line = new RegExp(`^${step}\\s+(\\{.*\\})$`, 'm').exec(stderr);
  assert.ok(line, `The hook must print what the ${step} step saw:\n${stderr}`);
  const value: unknown = JSON.parse(line[1] ?? '');
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    stderr,
  );
  return Object.fromEntries(Object.entries(value));
}

test('a snapshot of the staged commit holds the staged copy of each file, not an unstaged edit or an untracked file, and git there sees a clean checkout of a commit of the staged tree whose parent is HEAD', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Show extends Step<Commit> {
  readonly name = 'snapshot';
  async run(commit: Commit) {
    const snapshot = await commit.snapshot();
    const git = async (...args: string[]) =>
      (await snapshot.run('git', args)).stdout.trim();
    return this.pass(JSON.stringify({
      content: await readFile(join(snapshot.folder, 'a.txt'), 'utf8'),
      untracked: existsSync(join(snapshot.folder, 'untracked.txt')),
      status: await git('status', '--porcelain'),
      tree: await git('rev-parse', 'HEAD^{tree}'),
      staged: (await commit.tree()).id,
      parent: await git('rev-parse', 'HEAD^'),
    }));
  }
}
await preCommit([new Show()]);
`,
  );
  await repo.write('a.txt', 'base\n');
  await repo.git('add', 'package.json', 'a.txt');
  const base = await repo.commitWith([], 'base', '--no-verify');
  assert.equal(base.code, 0, base.stderr);
  const head = (await repo.git('rev-parse', 'HEAD')).trim();
  await repo.write('a.txt', 'staged\n');
  await repo.git('add', 'a.txt');
  // A peer's edit that is not staged, and a file that is not tracked.
  await repo.write('a.txt', 'unstaged\n');
  await repo.write('untracked.txt', 'untracked\n');

  // Act
  const result = await repo.commit('second');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const seen = printed(result.stderr, 'snapshot');
  assert.equal(seen.content, 'staged\n');
  assert.equal(seen.untracked, false);
  assert.equal(seen.status, '', 'git in the snapshot must see no change');
  assert.equal(
    seen.tree,
    seen.staged,
    'The snapshot must hold the staged tree',
  );
  assert.equal(seen.parent, head, 'The parent must be HEAD');
});

test('a tool in a snapshot gets the hook environment without the git variables of the repo, with NX_DAEMON=false and the pre-commit nx cache of the state folder (not the pre-push one, whose run summary Build reads), and the env of the call over it; git there reaches only the snapshot', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await installedRepository(
    folder.path,
    `import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Show extends Step<Commit> {
  readonly name = 'env';
  async run(commit: Commit) {
    const plain = await commit.snapshot();
    const run = await plain.run('node', ['-e', 'process.stdout.write(JSON.stringify(process.env))']);
    const packaged = await commit.snapshot({ packages: true });
    const bin = await packaged.bin('printenv', [], { env: { PROBE: 'given', HOME: '/overridden' } });
    const gitDir = await plain.run('git', ['rev-parse', '--absolute-git-dir']);
    return this.pass(JSON.stringify({
      hook: process.env,
      run: JSON.parse(run.stdout),
      bin: JSON.parse(bin.stdout),
      nxCacheDirectory: packaged.nxCacheDirectory,
      folder: plain.folder,
      gitDir: gitDir.stdout.trim(),
    }));
  }
}
await preCommit([new Show()]);
`,
  );
  await repo.write('a.txt', 'staged\n');
  await repo.git('add', 'a.txt');
  await repo.write('a.txt', 'unstaged\n');

  // Act
  // With --git-dir and --work-tree, git gives the hook GIT_DIR and
  // GIT_WORK_TREE of the committing repo, and GIT_INDEX_FILE of the commit.
  const result = await repo.commit(
    'first',
    `--git-dir=${join(repo.root, '.git')}`,
    `--work-tree=${repo.root}`,
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const seen = printed(result.stderr, 'env');
  const hook = seen.hook;
  assert.ok(typeof hook === 'object' && hook !== null);
  for (const name of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE'])
    assert.ok(name in hook, `git must give the hook ${name}`);
  const cache = join(repo.root, '.git/git-hooks/nx-pre-commit');
  assert.equal(seen.nxCacheDirectory, cache);
  const tool = {
    ...(await withoutLocalEnvVars(
      repo.git,
      Object.fromEntries(Object.entries(hook)),
    )),
    NX_DAEMON: 'false',
    NX_CACHE_DIRECTORY: cache,
    NX_WORKSPACE_DATA_DIRECTORY: join(cache, 'workspace-data'),
  };
  assert.deepEqual(seen.run, tool);
  assert.deepEqual(seen.bin, { ...tool, PROBE: 'given', HOME: '/overridden' });
  assert.equal(seen.gitDir, join(String(seen.folder), '.git'));
  assert.equal(
    await readFile(join(repo.root, 'a.txt'), 'utf8'),
    'unstaged\n',
    'The working tree of the repo must keep the unstaged edit',
  );
  assert.equal(await repo.git('show', 'HEAD:a.txt'), 'staged\n');
});

test('the steps of one hook share one snapshot of the staged tree, also two calls at once, a later ask for packages adds them to the same folder, and the folder is gone after the hook, also when a step throws', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await installedRepository(
    folder.path,
    `import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class First extends Step<Commit> {
  readonly name = 'first';
  async run(commit: Commit) {
    const [one, two] = await Promise.all([commit.snapshot(), commit.snapshot()]);
    return this.pass(JSON.stringify({
      one: one.folder,
      two: two.folder,
      packages: existsSync(join(one.folder, 'node_modules')),
    }));
  }
}
class Second extends Step<Commit> {
  readonly name = 'second';
  async run(commit: Commit) {
    const packaged = await commit.snapshot({ packages: true });
    return this.pass(JSON.stringify({
      folder: packaged.folder,
      packages: existsSync(join(packaged.folder, 'node_modules/.bin/printenv')),
    }));
  }
}
class Third extends Step<Commit> {
  readonly name = 'third';
  async run(): Promise<never> {
    throw new Error('the third step threw');
  }
}
await preCommit([new First(), new Second(), new Third()]);
`,
  );

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.notEqual(result.code, 0, result.stderr);
  assert.match(result.stderr, /the third step threw/);
  const first = printed(result.stderr, 'first');
  const second = printed(result.stderr, 'second');
  assert.equal(
    first.two,
    first.one,
    'Two calls at once must share one snapshot',
  );
  assert.equal(second.folder, first.one, 'Each step must share the snapshot');
  assert.equal(first.packages, false, 'A plain snapshot has no node_modules');
  assert.equal(second.packages, true);
  assert.equal(
    existsSync(String(first.one)),
    false,
    'The hook must delete the snapshot after the step that threw',
  );
});

// A hook whose step gives the commit that its snapshot checks out, and then
// fails, so no commit is made and the index stays.
const showCommit = `import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Show extends Step<Commit> {
  readonly name = 'commit';
  async run(commit: Commit) {
    const snapshot = await commit.snapshot();
    const git = async (...args: string[]) => (await snapshot.run('git', args)).stdout.trim();
    return this.fail(JSON.stringify({
      id: await git('rev-parse', 'HEAD'),
      parents: await git('rev-list', '--parents', '-n', '1', 'HEAD'),
      tree: await git('rev-parse', 'HEAD^{tree}'),
      staged: (await commit.tree()).id,
    }));
  }
}
await preCommit([new Show()]);
`;

test('the commit of a staged tree has one id for one tree and one parent: two runs of the hook with another author, committer and date check out the same commit, and another staged tree gives another commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showCommit);
  await repo.git('add', 'package.json');
  const base = await repo.commitWith([], 'base', '--no-verify');
  assert.equal(base.code, 0, base.stderr);
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');
  const commitAs = (name: string, date: string) =>
    hookedGit(['-c', 'core.hooksPath=.husky', 'commit', '--quiet', '-m', 'x'], {
      cwd: repo.root,
      env: {
        ...isolatedEnvironment(repo.root),
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: `${name}@example.com`,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: `${name}@example.com`,
        GIT_COMMITTER_DATE: date,
      },
    });

  // Act
  const one = await commitAs('one', '2001-01-01T00:00:00Z');
  const two = await commitAs('two', '2002-02-02T00:00:00Z');
  await repo.write('b.txt', 'b\n');
  await repo.git('add', 'b.txt');
  const other = await commitAs('two', '2002-02-02T00:00:00Z');

  // Assert
  const first = printed(one.stderr, 'commit');
  assert.equal(printed(two.stderr, 'commit').id, first.id);
  assert.equal(first.tree, first.staged);
  assert.notEqual(printed(other.stderr, 'commit').id, first.id);
});

test('before the first commit, the snapshot holds the staged tree in a commit with no parent', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showCommit);
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'package.json', 'a.txt');

  // Act
  const result = await repo.commit('first');

  // Assert
  const seen = printed(result.stderr, 'commit');
  assert.equal(seen.parents, seen.id, 'The commit must have no parent');
  assert.equal(seen.tree, seen.staged);
});

test('a snapshot with packages needs package-lock.json in the staged tree, and a snapshot without packages does not', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Show extends Step<Commit> {
  readonly name = 'lockfile';
  async run(commit: Commit) {
    const plain = await commit.snapshot();
    const error = await commit.snapshot({ packages: true }).then(
      () => 'no error',
      (error: Error) => error.message,
    );
    return this.pass(JSON.stringify({
      plain: existsSync(join(plain.folder, 'package.json')),
      error,
    }));
  }
}
await preCommit([new Show()]);
`,
  );
  await repo.git('add', 'package.json');

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(printed(result.stderr, 'lockfile'), {
    plain: true,
    error: 'the staged commit has no package-lock.json',
  });
});

test('a command in a snapshot gives its exit code, or null for a signal, and its output; a command that cannot start throws the error of Node', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Show extends Step<Commit> {
  readonly name = 'process';
  async run(commit: Commit) {
    const snapshot = await commit.snapshot();
    const failed = await snapshot.run('node', ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    const killed = await snapshot.run('node', ['-e', 'process.kill(process.pid, "SIGKILL")']);
    const missing = await snapshot.run('no-such-command-in-path', []).then(
      () => 'started',
      (error: NodeJS.ErrnoException) => error.code,
    );
    return this.pass(JSON.stringify({ failed, killed: killed.status, missing }));
  }
}
await preCommit([new Show()]);
`,
  );
  await repo.git('add', 'package.json');

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(printed(result.stderr, 'process'), {
    failed: { status: 3, stdout: 'out', stderr: 'err' },
    killed: null,
    missing: 'ENOENT',
  });
});

test('only a snapshot with packages has bin and nxCacheDirectory, and a packages option whose value the type checker does not know is a type error', () => {
  // A function that is never called: the type checker reads it.
  const read = async (commit: Commit, flag: boolean) => {
    const plain = await commit.snapshot();
    // @ts-expect-error a snapshot without packages has no node_modules/.bin.
    await plain.bin('nx', []);
    // @ts-expect-error a snapshot without packages has no nx cache to read.
    assert.ok(plain.nxCacheDirectory);
    // @ts-expect-error the type of the snapshot must be known.
    await commit.snapshot({ packages: flag });
    const packaged = await commit.snapshot({ packages: true });
    await packaged.bin('nx', []);
    return packaged.nxCacheDirectory;
  };
  assert.equal(typeof read, 'function');
});

test("a peer that holds the lock of the index while the hook runs, as git add and an editor's git status do, does not stop a step that reads the staged tree or its snapshot", async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { rm, writeFile } from 'node:fs/promises';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Show extends Step<Commit> {
  readonly name = 'locked';
  async run(commit: Commit) {
    // The lock file of git, as a peer holds it for the time of its command.
    await writeFile('.git/index.lock', '');
    try {
      const snapshot = await commit.snapshot();
      const tree = await commit.tree();
      return this.pass(JSON.stringify({ folder: snapshot.folder, tree: tree.id }));
    } finally {
      await rm('.git/index.lock');
    }
  }
}
await preCommit([new Show()]);
`,
  );
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'package.json', 'a.txt');

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    printed(result.stderr, 'locked').tree,
    (await repo.git('rev-parse', 'HEAD^{tree}')).trim(),
  );
});

// A step that runs commit.generate with the globs `gen/**`: its work writes a
// new file, changes a file, deletes a file, makes a link and an executable
// script under gen/, and writes other.txt outside the globs. It prints what
// generate gave.
const generating = `import { chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Generate extends Step<Commit> {
  readonly name = 'generate';
  async run(commit: Commit) {
    const generated = await commit.generate(['gen/**'], async ({ folder }) => {
      await writeFile(join(folder, 'gen/new.txt'), 'new\\n');
      await writeFile(join(folder, 'gen/changed.txt'), 'changed\\n');
      await rm(join(folder, 'gen/old.txt'));
      await symlink('new.txt', join(folder, 'gen/link'));
      await writeFile(join(folder, 'gen/run.sh'), '#!/bin/sh\\n');
      await chmod(join(folder, 'gen/run.sh'), 0o755);
      await writeFile(join(folder, 'other.txt'), 'outside\\n');
    });
    if (generated.kind === 'not-staged') return this.fail(generated.reason);
    return this.pass(JSON.stringify({ paths: generated.entries.map(({ path }) => path).sort() }));
  }
}
await preCommit([new Generate()]);
`;

// A repo whose base commit holds gen/changed.txt and gen/old.txt, and whose
// staged commit has a.txt changed.
async function generatingRepository(root: string, hook: string) {
  const repo = await installedRepository(root, hook);
  await mkdir(join(root, 'gen'));
  await repo.write('gen/changed.txt', 'base\n');
  await repo.write('gen/old.txt', 'old\n');
  await repo.write('a.txt', 'base\n');
  await repo.git('add', '--all');
  const base = await repo.commitWith([], 'base', '--no-verify');
  assert.equal(base.code, 0, base.stderr);
  await repo.write('a.txt', 'staged\n');
  await repo.git('add', 'a.txt');
  return repo;
}

test('generate stages each file that its work wrote under the globs: a new file, a changed file, a deletion, a link and an executable script; the working-tree copies follow, and a file outside the globs reaches neither the commit nor the working tree', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await generatingRepository(folder.path, generating);

  // Act
  const result = await repo.commit('second');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(printed(result.stderr, 'generate').paths, [
    'gen/changed.txt',
    'gen/link',
    'gen/new.txt',
    'gen/old.txt',
    'gen/run.sh',
  ]);
  const tree = await repo.git(
    'ls-tree',
    '-r',
    'HEAD',
    '--',
    'gen',
    'other.txt',
  );
  assert.match(tree, /^100644 blob \S+\tgen\/new\.txt$/m);
  assert.match(tree, /^100644 blob \S+\tgen\/changed\.txt$/m);
  assert.match(tree, /^120000 blob \S+\tgen\/link$/m);
  assert.match(tree, /^100755 blob \S+\tgen\/run\.sh$/m);
  assert.doesNotMatch(tree, /gen\/old\.txt|other\.txt/);
  assert.equal(await repo.git('show', 'HEAD:gen/changed.txt'), 'changed\n');
  assert.equal(await repo.git('show', 'HEAD:gen/link'), 'new.txt');
  assert.equal(
    await readFile(join(folder.path, 'gen/changed.txt'), 'utf8'),
    'changed\n',
    'An unchanged working-tree copy gets the generated content',
  );
  assert.equal(existsSync(join(folder.path, 'gen/old.txt')), false);
  assert.equal(existsSync(join(folder.path, 'other.txt')), false);
  assert.equal(
    await repo.git('status', '--porcelain', '--', 'gen'),
    '',
    'The working tree, the index and the commit agree on gen/',
  );
});

test('a commit that names its paths (git commit --only) cannot stage what a step generates: it stops, names each generated path and the command that commits them, and commits nothing', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await generatingRepository(folder.path, generating);
  const head = (await repo.git('rev-parse', 'HEAD')).trim();

  // Act
  const result = await repo.commitWith([], 'second', '--only', '--', 'a.txt');

  // Assert
  assert.notEqual(result.code, 0, result.stderr);
  assert.match(result.stderr, /git commit --only <your paths> .*gen\/new\.txt/);
  for (const path of [
    'gen/changed.txt',
    'gen/link',
    'gen/old.txt',
    'gen/run.sh',
  ])
    assert.match(
      result.stderr,
      new RegExp(`^\\s+${path.replace('.', '\\.')}$`, 'm'),
    );
  assert.equal((await repo.git('rev-parse', 'HEAD')).trim(), head);
});

test('another git command that stages a file while the hook runs stops the commit, because the index no longer holds the tree that the steps judged, and nothing is committed', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await installedRepository(
    folder.path,
    `import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
// Stands for another session: it stages peer.txt while the hook runs.
class Peer extends Step<Commit> {
  readonly name = 'peer';
  async run() {
    writeFileSync('peer.txt', 'peer\\n');
    execFileSync('git', ['add', 'peer.txt']);
    return this.pass('staged peer.txt');
  }
}
await preCommit([new Peer()]);
`,
  );
  await repo.write('a.txt', 'base\n');
  await repo.git('add', '--all');
  const base = await repo.commitWith([], 'base', '--no-verify');
  assert.equal(base.code, 0, base.stderr);
  const head = (await repo.git('rev-parse', 'HEAD')).trim();
  await repo.write('a.txt', 'staged\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit('second');

  // Assert
  assert.notEqual(result.code, 0, result.stderr);
  assert.match(result.stderr, /the index changed while the hook ran/);
  assert.equal((await repo.git('rev-parse', 'HEAD')).trim(), head);
});
