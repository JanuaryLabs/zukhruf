import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/testing/fs';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('./index.ts');

// A git repo in a temp folder whose pre-push hook is `.husky/pre-push.ts`,
// reached through the committed link `.husky/pre-push`, as a repo installs
// it, and a bare remote `origin` beside it. git, npm and the hook see none of
// the user's config and no environment of the Nx task that runs this test.
// PROBE_MARKS is the folder where a script of the repo leaves a mark when it
// runs.
async function repository(top: string, hook: string) {
  const root = join(top, 'repo');
  const remote = join(top, 'remote.git');
  const marks = join(top, 'marks');
  await mkdir(root);
  await mkdir(marks);
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
    PROBE_MARKS: marks,
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
    marks,
    environment,
    git,
    write,
    async commit(message: string) {
      await git('add', '--all');
      await git('commit', '--quiet', '--no-verify', '-m', message);
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async push(...args: string[]) {
      try {
        const { stderr } = await execFileAsync(
          'git',
          ['-c', 'core.hooksPath=.husky', 'push', ...args],
          { cwd: root, env: environment },
        );
        return { code: 0, stderr };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          !('stderr' in error)
        )
          throw error;
        return { code: Number(error.code), stderr: String(error.stderr) };
      }
    },
  };
}

// An npm workspace whose dependencies are tarballs in the temp folder, so no
// install reaches the registry: probe-dep 1.0.0 and 2.0.0, scripted-dep with
// an install script that writes built.txt into its folder, and extra-dep. The
// root and the workspace package @probe/ws have scripts that leave a mark.
// The repo approves scripted-dep in `allowScripts` of package.json, with the
// key that `npm install-scripts approve` writes. npm 12 runs no install script
// of a dependency that the repo does not approve. npm 11 ignores the field.
// `install(dependencies)` sets the dependencies of package.json and runs
// `npm install` the way a person does, with no scripts.
async function workspace(folder: string, hook: string) {
  const repo = await repository(folder, hook);
  const npm = (cwd: string, ...args: string[]) =>
    execFileAsync('npm', [...args, '--offline', '--no-audit', '--no-fund'], {
      cwd,
      env: repo.environment,
    });
  const tarballs = join(repo.top, 'tarballs');
  await mkdir(tarballs);
  const pack = async (name: string, version: string, scripts = {}) => {
    const source = join(repo.top, 'sources', `${name}-${version}`);
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js', scripts }),
    );
    await writeFile(
      join(source, 'index.js'),
      `exports.version = '${version}';\n`,
    );
    await npm(source, 'pack', '--pack-destination', tarballs);
    return `file:${join(tarballs, `${name}-${version}.tgz`)}`;
  };
  const tarball = {
    probe1: await pack('probe-dep', '1.0.0'),
    probe2: await pack('probe-dep', '2.0.0'),
    scripted: await pack('scripted-dep', '1.0.0', {
      install: `node -e "require('fs').writeFileSync('built.txt', '')"`,
    }),
    extra: await pack('extra-dep', '1.0.0'),
  };
  const mark = (name: string) =>
    `node -e "require('fs').writeFileSync(require('path').join(process.env.PROBE_MARKS, '${name}'), '')"`;
  await repo.write('.gitignore', 'node_modules\n');
  await repo.write(
    'packages/ws/package.json',
    `${JSON.stringify({
      name: '@probe/ws',
      version: '0.0.0',
      scripts: { install: mark('ws-install'), prepare: mark('ws-prepare') },
    })}\n`,
  );
  const install = async (dependencies: Record<string, string>) => {
    await repo.write(
      'package.json',
      `${JSON.stringify({
        name: 'probe',
        private: true,
        workspaces: ['packages/*'],
        scripts: {
          prepare: mark('root-prepare'),
          postinstall: mark('root-postinstall'),
        },
        dependencies,
        allowScripts: { [tarball.scripted]: true },
      })}\n`,
    );
    await npm(repo.root, 'install', '--ignore-scripts');
  };
  return { ...repo, tarball, install };
}

// A step that reads the node_modules of the snapshot of the pushed commit.
const inspect = `import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Inspect extends Step<Push> {
  readonly name = 'inspect';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete') return this.fail('no head');
    const seen = await push.inSnapshot(update.head, async (folder) => {
      const modules = join(folder, 'node_modules');
      return {
        probe: JSON.parse(readFileSync(join(modules, 'probe-dep/package.json'), 'utf8')).version,
        built: existsSync(join(modules, 'scripted-dep/built.txt')),
        extra: existsSync(join(modules, 'extra-dep')),
        workspace: realpathSync(join(modules, '@probe/ws')) === realpathSync(join(folder, 'packages/ws')),
      };
    }).catch((error: Error) => error);
    if (seen instanceof Error) return this.fail(seen.message.trimEnd());
    return this.pass(JSON.stringify(seen));
  }
}
await prePush([new Inspect()]);
`;

function seen(stderr: string): unknown {
  const line = /^inspect\s+(\{.*\})$/m.exec(stderr);
  assert.ok(line, stderr);
  return JSON.parse(line[1] ?? '');
}

const installing = (head: string) =>
  new RegExp(
    `^inspect\\s+${head.slice(0, 7)}: the installed packages differ from package-lock.json; installing it with npm ci \\(first time for this lockfile\\)$`,
    'm',
  );

test(
  'a different installed version makes the snapshot use an install of the pushed lockfile, which ran the install scripts of the dependencies and no script of the repo',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await workspace(folder.path, inspect);
    await repo.install({
      'probe-dep': repo.tarball.probe2,
      'scripted-dep': repo.tarball.scripted,
    });
    const head = await repo.commit('probe-dep 2');
    // A peer installs another version and does not commit it.
    await repo.install({
      'probe-dep': repo.tarball.probe1,
      'scripted-dep': repo.tarball.scripted,
    });

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, installing(head));
    assert.deepEqual(seen(result.stderr), {
      probe: '2.0.0',
      built: true,
      extra: false,
      workspace: true,
    });
    assert.deepEqual(
      await readdir(repo.marks),
      [],
      'No script of the repo or its workspace packages may run',
    );
  },
);

test(
  'a package that the pushed lockfile names and that is not installed makes the snapshot use an install of the pushed lockfile',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await workspace(folder.path, inspect);
    await repo.install({
      'probe-dep': repo.tarball.probe1,
      'scripted-dep': repo.tarball.scripted,
    });
    const head = await repo.commit('two dependencies');
    await repo.install({ 'probe-dep': repo.tarball.probe1 });

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, installing(head));
    assert.deepEqual(seen(result.stderr), {
      probe: '1.0.0',
      built: true,
      extra: false,
      workspace: true,
    });
  },
);

test(
  'a repo with no node_modules gets an install of the pushed lockfile',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await workspace(folder.path, inspect);
    await repo.install({
      'probe-dep': repo.tarball.probe1,
      'scripted-dep': repo.tarball.scripted,
    });
    const head = await repo.commit('first');
    await rm(join(repo.root, 'node_modules'), { recursive: true });

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, installing(head));
    assert.deepEqual(seen(result.stderr), {
      probe: '1.0.0',
      built: true,
      extra: false,
      workspace: true,
    });
  },
);

test(
  'an installed package that the pushed lockfile does not name makes the snapshot use an install without it',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await workspace(folder.path, inspect);
    await repo.install({
      'probe-dep': repo.tarball.probe1,
      'scripted-dep': repo.tarball.scripted,
    });
    const head = await repo.commit('first');
    await repo.install({
      'probe-dep': repo.tarball.probe1,
      'scripted-dep': repo.tarball.scripted,
      'extra-dep': repo.tarball.extra,
    });

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, installing(head));
    assert.deepEqual(seen(result.stderr), {
      probe: '1.0.0',
      built: true,
      extra: false,
      workspace: true,
    });
  },
);

test(
  'a push with a lockfile that was installed before uses that install, and the hook keeps the two installs that it used last',
  { timeout: 120_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await workspace(folder.path, inspect);
    const lockfiles = {
      one: { 'probe-dep': repo.tarball.probe1 },
      two: { 'probe-dep': repo.tarball.probe2 },
      three: {
        'probe-dep': repo.tarball.probe1,
        'extra-dep': repo.tarball.extra,
      },
    };
    // Each push has drift: no packages are installed.
    const pushWith = async (
      dependencies: Record<string, string>,
      note: string,
    ) => {
      await repo.install(dependencies);
      await repo.write('notes.txt', `${note}\n`);
      const head = await repo.commit(note);
      await rm(join(repo.root, 'node_modules'), { recursive: true });
      const result = await repo.push('--quiet', 'origin', 'main');
      assert.equal(result.code, 0, result.stderr);
      return { head, stderr: result.stderr };
    };
    await pushWith(lockfiles.one, 'one');
    await pushWith(lockfiles.two, 'two');

    // Act
    const reused = await pushWith(lockfiles.one, 'one again');
    await pushWith(lockfiles.three, 'three');
    const pruned = await pushWith(lockfiles.two, 'two again');

    // Assert
    assert.doesNotMatch(
      reused.stderr,
      /installing/,
      'The install of lockfile one is used again',
    );
    assert.deepEqual(seen(reused.stderr), {
      probe: '1.0.0',
      built: false,
      extra: false,
      workspace: true,
    });
    assert.match(
      pruned.stderr,
      installing(pruned.head),
      'Lockfile two was used least recently, so its install was deleted',
    );
    // The state folder is documented, and the pruning has no other output.
    assert.equal(
      (await readdir(join(repo.root, '.git/git-hooks/installs'))).length,
      2,
    );
  },
);

test(
  'an install that fails stops the push with the reason npm gave, and the next push installs that lockfile again',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await workspace(folder.path, inspect);
    await repo.install({
      'probe-dep': repo.tarball.probe1,
      'scripted-dep': repo.tarball.scripted,
    });
    const head = await repo.commit('first');
    await rm(join(repo.root, 'node_modules'), { recursive: true });
    const tarball = repo.tarball.probe1.slice('file:'.length);
    const content = await readFile(tarball);
    await writeFile(tarball, 'not a tarball');

    // Act
    const failed = await repo.push('--quiet', 'origin', 'main');
    await writeFile(tarball, content);
    const retried = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.notEqual(failed.code, 0, failed.stderr);
    assert.match(
      failed.stderr,
      /^inspect\s+npm ci --ignore-scripts --no-audit --no-fund failed:$/m,
    );
    assert.match(
      failed.stderr,
      /^ {10}npm error code TAR_BAD_ARCHIVE$/m,
      'The hook must show the reason that npm gave',
    );
    assert.match(failed.stderr, /^✖ push stopped by the pre-push hook$/m);
    assert.equal(retried.code, 0, retried.stderr);
    assert.match(
      retried.stderr,
      installing(head),
      'The install that did not end is not used',
    );
    assert.deepEqual(seen(retried.stderr), {
      probe: '1.0.0',
      built: true,
      extra: false,
      workspace: true,
    });
  },
);

// A repo whose root depends on shim-dep from the folder vendor/shim-dep
// (`file:`), which is not a workspace package, as a repo vendors a fixed copy
// of a package. npm links node_modules/shim-dep to vendor/shim-dep.
// carrier-dep, a tarball in the temp folder, depends on shim-dep and reads it
// from its own folder in node_modules. The step requires carrier-dep in
// the snapshot of the pushed commit, and shows the value that it reads through
// the link. `vendor(value)` writes the folder with that value.
async function vendored(folder: string) {
  const repo = await repository(
    folder,
    `import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Inspect extends Step<Push> {
  readonly name = 'inspect';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete') return this.fail('no head');
    const seen = await push.inSnapshot(update.head, async (folder) =>
      createRequire(join(folder, 'index.js'))('carrier-dep').value,
    ).catch((error: Error) => error);
    if (seen instanceof Error) return this.fail(seen.message.trimEnd());
    return this.pass(JSON.stringify({ value: seen }));
  }
}
await prePush([new Inspect()]);
`,
  );
  const npm = (cwd: string, ...args: string[]) =>
    execFileAsync('npm', [...args, '--offline', '--no-audit', '--no-fund'], {
      cwd,
      env: repo.environment,
    });
  const pack = async (
    name: string,
    version: string,
    dependencies: Record<string, string>,
    code: string,
  ) => {
    const source = join(repo.top, 'sources', `${name}-${version}`);
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({ name, version, main: 'index.js', dependencies }),
    );
    await writeFile(join(source, 'index.js'), code);
    await npm(source, 'pack', '--pack-destination', repo.top);
    return `file:${join(repo.top, `${name}-${version}.tgz`)}`;
  };
  const leaf = (version: string) =>
    pack('leaf-dep', version, {}, `exports.version = '${version}';\n`);
  const tarball = {
    carrier: await pack(
      'carrier-dep',
      '1.0.0',
      { 'shim-dep': '^1.0.0' },
      `exports.value = require('shim-dep').value;\n`,
    ),
    leaf1: await leaf('1.0.0'),
    leaf2: await leaf('2.0.0'),
  };
  // shim-dep needs leaf-dep 2 and the root has leaf-dep 1, so npm installs
  // leaf-dep 2 in vendor/shim-dep/node_modules.
  const vendor = async (value: string) => {
    await repo.write(
      'vendor/shim-dep/package.json',
      `${JSON.stringify({
        name: 'shim-dep',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { 'leaf-dep': tarball.leaf2 },
      })}\n`,
    );
    await repo.write(
      'vendor/shim-dep/index.js',
      `exports.value = \`${value} \${require('leaf-dep').version}\`;\n`,
    );
  };
  await vendor('first');
  await repo.write('.gitignore', 'node_modules\n');
  await repo.write(
    'package.json',
    `${JSON.stringify({
      name: 'probe',
      private: true,
      dependencies: {
        'carrier-dep': tarball.carrier,
        'leaf-dep': tarball.leaf1,
        'shim-dep': 'file:vendor/shim-dep',
      },
    })}\n`,
  );
  await npm(repo.root, 'install', '--ignore-scripts');
  return { ...repo, vendor };
}

test(
  'a package that the pushed lockfile links to a folder outside the workspaces reads that folder of the pushed commit from an install of the lockfile',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await vendored(folder.path);
    const head = await repo.commit('vendored shim-dep');
    await rm(join(repo.root, 'node_modules'), { recursive: true });

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, installing(head));
    assert.deepEqual(seen(result.stderr), { value: 'first 2.0.0' });
  },
);

test(
  'a push that changes a linked folder outside the workspaces and keeps the lockfile reads the new folder through the install of the lockfile',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await new TemporaryFiles().directory('git-hooks-');
    const repo = await vendored(folder.path);
    await repo.commit('vendored shim-dep');
    await rm(join(repo.root, 'node_modules'), { recursive: true });
    const first = await repo.push('--quiet', 'origin', 'main');
    assert.equal(first.code, 0, first.stderr);
    await repo.vendor('second');
    await repo.commit('shim-dep second');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /installing/,
      'The install of the same lockfile is used again',
    );
    assert.deepEqual(seen(result.stderr), { value: 'second 2.0.0' });
  },
);
