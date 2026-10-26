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

import { Format, prePush } from './index.ts';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('./index.ts');
const zukhrufModules = new URL('../../../node_modules', import.meta.url)
  .pathname;

// A git repo in a temp folder whose pre-push hook is `.husky/pre-push.ts`,
// reached through the committed link `.husky/pre-push`, as a repo installs
// it, and a bare remote `origin` beside it. git, npm and the hook see none of
// the user's config and no environment of the Nx task that runs this test.
async function repository(folder: string, hook: string) {
  const top = await realpath(folder);
  const root = join(top, 'repo');
  const remote = join(top, 'remote.git');
  await mkdir(root);
  await mkdir(join(top, 'home'));
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(top, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const gitIn = async (cwd: string, ...args: string[]) =>
    (await execFileAsync('git', args, { cwd, env: environment })).stdout;
  const git = (...args: string[]) => gitIn(root, ...args);
  await gitIn(
    top,
    'init',
    '--quiet',
    '--bare',
    '--initial-branch=main',
    remote,
  );
  await git('init', '--quiet', '--initial-branch=main');
  await git('remote', 'add', 'origin', remote);
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await mkdir(join(root, '.husky'));
  await writeFile(
    join(root, '.husky/pre-push.ts'),
    `#!/usr/bin/env node\n${hook.replaceAll('@zukhruf/git-hooks', packageEntry)}`,
  );
  await chmod(join(root, '.husky/pre-push.ts'), 0o755);
  await symlink('pre-push.ts', join(root, '.husky/pre-push'));
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  return {
    top,
    root,
    remote,
    environment,
    git,
    gitIn,
    write,
    async commit(message: string) {
      await git('add', '--all');
      await git('commit', '--quiet', '--no-verify', '-m', message);
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async push(...args: string[]) {
      try {
        const { stdout, stderr } = await execFileAsync(
          'git',
          ['-c', 'core.hooksPath=.husky', 'push', ...args],
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

// A hook whose one step gives the remote and the ref updates that prePush
// read, as JSON on its outcome line.
const showUpdates = `import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Show extends Step<Push> {
  readonly name = 'updates';
  async run(push: Push) {
    return this.pass(JSON.stringify({ remote: push.remote, updates: push.updates }));
  }
}
await prePush([new Show()]);
`;

interface Shown {
  remote: { name: string; url: string };
  updates: Record<string, string | undefined>[];
}

function shown(stderr: string): Shown {
  const line = /^updates\s+(\{.*\})$/m.exec(stderr);
  assert.ok(line, `The hook must print the updates:\n${stderr}`);
  const value: unknown = JSON.parse(line[1] ?? '');
  assert.ok(isShown(value), `not the updates: ${stderr}`);
  return value;
}

function isShown(value: unknown): value is Shown {
  return (
    typeof value === 'object' &&
    value !== null &&
    'remote' in value &&
    'updates' in value &&
    Array.isArray(value.updates)
  );
}

test(
  'the first push of a history to an empty remote is a create with no base, so a step checks the whole history',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(folder.path, showUpdates);
    await repo.write('a.txt', 'a\n');
    const head = await repo.commit('first');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(shown(result.stderr), {
      remote: { name: 'origin', url: repo.remote },
      updates: [
        {
          kind: 'create',
          localRef: 'refs/heads/main',
          localSha: head,
          remoteRef: 'refs/heads/main',
          remoteSha: '0'.repeat(40),
          head,
        },
      ],
    });
  },
);

test(
  'a new branch is a create whose base is the newest commit that the remote has, from the commits that no remote ref has',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(folder.path, showUpdates);
    await repo.write('a.txt', 'a\n');
    const pushed = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main');
    await repo.git('switch', '--quiet', '--create', 'feature');
    await repo.write('b.txt', 'b\n');
    await repo.commit('second');
    await repo.write('c.txt', 'c\n');
    const head = await repo.commit('third');

    // Act
    const result = await repo.push('--quiet', 'origin', 'feature');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    const [update] = shown(result.stderr).updates;
    assert.equal(update?.kind, 'create');
    assert.equal(update.head, head);
    assert.equal(
      update.base,
      pushed,
      'The base is the parent of the first commit that the remote does not have',
    );
  },
);

test(
  'an update has the remote sha as its base',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(folder.path, showUpdates);
    await repo.write('a.txt', 'a\n');
    const pushed = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main');
    await repo.write('b.txt', 'b\n');
    const head = await repo.commit('second');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    const [update] = shown(result.stderr).updates;
    assert.equal(update?.kind, 'update');
    assert.equal(update.remoteSha, pushed);
    assert.equal(update.base, pushed);
    assert.equal(update.head, head);
  },
);

test(
  'a force push over a remote commit that was never fetched gets its base from the commits that no remote ref has',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(folder.path, showUpdates);
    await repo.write('a.txt', 'a\n');
    const pushed = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main');
    // Another clone pushes a commit that this repo never fetches.
    const other = join(repo.top, 'other');
    await repo.gitIn(repo.top, 'clone', '--quiet', repo.remote, other);
    await writeFile(join(other, 'x.txt'), 'x\n');
    await repo.gitIn(other, 'add', 'x.txt');
    await repo.gitIn(other, 'commit', '--quiet', '-m', 'unseen');
    await repo.gitIn(other, 'push', '--quiet', 'origin', 'main');
    const unseen = (await repo.gitIn(other, 'rev-parse', 'HEAD')).trim();
    await repo.write('b.txt', 'b\n');
    const head = await repo.commit('second');

    // Act
    const result = await repo.push('--quiet', '--force', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    const [update] = shown(result.stderr).updates;
    assert.equal(update?.kind, 'update');
    assert.equal(update.remoteSha, unseen);
    assert.equal(
      update.base,
      pushed,
      'The remote sha is not in the local repo, so the base is the parent of the first commit that no remote ref has',
    );
    assert.equal(update.head, head);
  },
);

test(
  'a push of a commit that the remote has already has an empty range: the base is the head',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(folder.path, showUpdates);
    await repo.write('a.txt', 'a\n');
    const head = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main:refs/heads/copy');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    const [update] = shown(result.stderr).updates;
    assert.equal(update?.kind, 'create');
    assert.equal(update.remoteRef, 'refs/heads/copy');
    assert.equal(update.base, head);
    assert.equal(update.head, head);
  },
);

test(
  'a push that deletes a ref gives a delete with no head and no base',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(folder.path, showUpdates);
    await repo.write('a.txt', 'a\n');
    const pushed = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main', 'main:refs/heads/copy');

    // Act
    const result = await repo.push('--quiet', 'origin', ':refs/heads/copy');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(shown(result.stderr).updates, [
      {
        kind: 'delete',
        localRef: '(delete)',
        localSha: '0'.repeat(40),
        remoteRef: 'refs/heads/copy',
        remoteSha: pushed,
      },
    ]);
  },
);

test(
  'a pre-push step that fails stops the push with its reason, and no step runs after it',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await repository(
      folder.path,
      `import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Refuse extends Step<Push> {
  readonly name = 'refuse';
  async run() {
    return this.fail('this repo takes no push today');
  }
}
class After extends Step<Push> {
  readonly name = 'after';
  async run() {
    return this.pass('ran after the failed step');
  }
}
await prePush([new Refuse(), new After()]);
`,
    );
    await repo.write('a.txt', 'a\n');
    await repo.commit('first');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.notEqual(result.code, 0, 'The step fails');
    assert.match(result.stderr, /^refuse\s+this repo takes no push today$/m);
    assert.match(result.stderr, /^✖ push stopped by the pre-push hook$/m);
    assert.doesNotMatch(result.stderr, /ran after the failed step/);
    assert.equal(
      await repo.gitIn(repo.top, '--git-dir', repo.remote, 'rev-list', '--all'),
      '',
      'The remote must get no commit',
    );
  },
);

// An Nx workspace of npm with three projects, installed the way npm installs
// it: a real node_modules with the workspace links, nx (linked from
// zukhruf's install, since no test may install from the registry), and npm's
// hidden lockfile. The committed package-lock.json matches the install.
async function workspace(folder: string, hook: string) {
  const repo = await repository(folder, hook);
  const names = ['a', 'b', 'c'];
  const nxVersion = '23.2.1';
  await repo.write('.gitignore', 'node_modules\n.nx\n');
  await repo.write(
    'package.json',
    '{ "name": "probe", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
  );
  await repo.write('nx.json', '{}\n');
  const packages: Record<string, object> = {
    'node_modules/nx': { version: nxVersion, license: 'MIT' },
  };
  for (const name of names) {
    await repo.write(
      `packages/${name}/package.json`,
      `${JSON.stringify({ name: `@probe/${name}`, version: '0.0.0', type: 'module' })}\n`,
    );
    await repo.write(`packages/${name}/index.js`, 'export const value = 1;\n');
    packages[`node_modules/@probe/${name}`] = {
      resolved: `packages/${name}`,
      link: true,
    };
    packages[`packages/${name}`] = { name: `@probe/${name}`, version: '0.0.0' };
    await mkdir(join(repo.root, 'node_modules/@probe'), { recursive: true });
    await symlink(
      `../../packages/${name}`,
      join(repo.root, `node_modules/@probe/${name}`),
    );
  }
  await symlink(join(zukhrufModules, 'nx'), join(repo.root, 'node_modules/nx'));
  await mkdir(join(repo.root, 'node_modules/.bin'));
  await symlink(
    '../nx/dist/bin/nx.js',
    join(repo.root, 'node_modules/.bin/nx'),
  );
  await repo.write(
    'node_modules/.package-lock.json',
    `${JSON.stringify({ name: 'probe', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`,
  );
  await repo.write(
    'package-lock.json',
    `${JSON.stringify(
      {
        name: 'probe',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'probe', workspaces: ['packages/*'] },
          ...packages,
        },
      },
      null,
      2,
    )}\n`,
  );
  return repo;
}

test(
  'push.nx sees a clean checkout of the head: nx affected lists the projects of the pushed range, and not the edits or new files in the working tree',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(
      folder.path,
      `import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Affected extends Step<Push> {
  readonly name = 'affected';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete' || update.base === undefined)
      return this.fail('no range');
    const affected = (...range: string[]) =>
      push.nx(update.head, 'show', 'projects', '--affected', ...range, '--json');
    const ranged = await affected(\`--base=\${update.base}\`, \`--head=\${update.head}\`);
    const uncommitted = await affected(\`--base=\${update.base}\`);
    return this.pass(JSON.stringify({ ranged: JSON.parse(ranged), uncommitted: JSON.parse(uncommitted) }));
  }
}
await prePush([new Affected()]);
`,
    );
    await repo.commit('base');
    await repo.git('push', '--quiet', 'origin', 'main');
    await repo.write('packages/a/index.js', 'export const value = 2;\n');
    await repo.commit('change a');
    // A peer's edit and a new file, both only in the working tree.
    await repo.write('packages/b/index.js', 'export const value = 3;\n');
    await repo.git('add', 'packages/b/index.js');
    await repo.write('packages/c/new.js', 'export const added = true;\n');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    const line = /^affected\s+(\{.*\})$/m.exec(result.stderr);
    assert.ok(line, result.stderr);
    assert.deepEqual(JSON.parse(line[1] ?? ''), {
      ranged: ['@probe/a'],
      uncommitted: ['@probe/a'],
    });
    assert.equal(
      existsSync(join(repo.root, '.nx')),
      false,
      'nx must not write the .nx folder of the working tree',
    );
    assert.equal(
      await repo.git('diff', '--cached', '--name-only'),
      'packages/b/index.js\n',
      'The index of the repo must keep what the peer staged',
    );
  },
);

test(
  'prePush takes only pre-push steps: a pre-commit step is a type error',
  { timeout: 60_000 },
  () => {
    // A function that is never called: the type checker reads it.
    const hook = () =>
      // @ts-expect-error a Step<Commit> has no push to judge.
      prePush([new Format()]);
    assert.equal(typeof hook, 'function');
  },
);
