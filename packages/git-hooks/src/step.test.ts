import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

test("a repo's own step stops the commit with its reason when it fails, a step that skips lets the next steps run, and no step runs after a failed one", async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(
    folder.path,
    `import { Step, preCommit } from '@zukhruf/git-hooks';
class Nothing extends Step {
  readonly name = 'nothing';
  async run() {
    return this.skip('nothing to check here');
  }
}
class Refuse extends Step {
  readonly name = 'refuse';
  async run() {
    return this.fail('this repo takes no commit today');
  }
}
class After extends Step {
  readonly name = 'after';
  async run() {
    return this.pass('ran after the failed step');
  }
}
await preCommit([new Nothing(), new Refuse(), new After()]);
`,
  );
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit('refused');

  // Assert
  assert.notEqual(result.code, 0, 'The repo step fails');
  assert.match(
    result.stderr,
    /nothing to check here/,
    'The skipped step must say why, and the next step must run',
  );
  assert.match(
    result.stderr,
    /this repo takes no commit today/,
    'The hook must give the reason of the failed step',
  );
  assert.doesNotMatch(
    result.stderr,
    /ran after the failed step/,
    'No step may run after the failed step',
  );
  assert.equal(
    await repo.git('rev-list', '--all', '--count'),
    '0\n',
    'No commit may exist',
  );
});

test('a step that reads the staged commit in a snapshot sees the staged copy of the tree, the snapshot is gone after the hook, and a commit that stages no file the step reads skips it', async () => {
  // Arrange
  await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
  const repo = await repository(
    folder.path,
    `import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Design extends Step {
  readonly name = 'design';
  async run(commit: Commit) {
    if (!(await commit.touches(['docs/**'])))
      return this.skip('no design files staged');
    const seen = await commit.inSnapshot(async (snapshot) => ({
      snapshot,
      content: await readFile(join(snapshot, 'docs/design.md'), 'utf8'),
    }));
    return seen.content === 'staged\\n'
      ? this.pass(\`checked the staged copy in \${seen.snapshot}\`)
      : this.fail(\`read \${JSON.stringify(seen.content)}, not the staged copy\`);
  }
}
await preCommit([new Design()]);
`,
  );
  await mkdir(join(repo.root, 'docs'));
  await repo.write('docs/design.md', 'staged\n');
  await repo.git('add', 'docs/design.md');
  await repo.write('docs/design.md', 'unstaged\n');

  // Act
  const result = await repo.commit('design');
  await repo.write('notes.txt', 'notes\n');
  await repo.git('add', 'notes.txt');
  const skipped = await repo.commit('no design');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const snapshot = /checked the staged copy in (\S+)/.exec(result.stderr)?.[1];
  assert.ok(snapshot, 'The step must report the snapshot it read');
  assert.equal(
    existsSync(snapshot),
    false,
    'The hook must remove the snapshot afterwards',
  );
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.match(
    skipped.stderr,
    /no design files staged/,
    'A commit that stages no docs file must skip the design step',
  );
});
