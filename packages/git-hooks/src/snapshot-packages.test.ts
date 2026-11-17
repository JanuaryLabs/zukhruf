import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { hash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

import { isolatedEnvironment } from './testing/hooked-repository.ts';
import { repository } from './testing/pre-commit-repository.ts';
import { probeTarball } from './testing/probe-tarball.ts';

const execFileAsync = promisify(execFile);

// A step that reads the node_modules of the snapshot of the staged commit,
// with packages: the version and the code of probe-dep, and what the install
// script of scripted-dep saw.
const showPackages = `import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
class Show extends Step<Commit> {
  readonly name = 'packages';
  async run(commit: Commit) {
    const snapshot = await commit.snapshot({ packages: true });
    const modules = join(snapshot.folder, 'node_modules');
    const probe = read(join(modules, 'probe-dep/package.json'));
    return this.pass(JSON.stringify({
      hookIndex: 'GIT_INDEX_FILE' in process.env,
      probe: probe === null ? null : JSON.parse(probe).version,
      code: read(join(modules, 'probe-dep/index.js')),
      seen: JSON.parse(read(join(modules, 'scripted-dep/seen.json')) ?? 'null'),
    }));
  }
}
await preCommit([new Show()]);
`;

function shown(stderr: string): Record<string, unknown> {
  const line = /^packages\s+(\{.*\})$/m.exec(stderr);
  assert.ok(line, `The hook must print what the step saw:\n${stderr}`);
  const value: unknown = JSON.parse(line[1] ?? '');
  assert.ok(typeof value === 'object' && value !== null, stderr);
  return Object.fromEntries(Object.entries(value));
}

const installing =
  /^packages\s+the staged commit: the installed packages differ from package-lock\.json; installing it with npm ci \(first time for this lockfile\)$/m;

// A repo in `top/repo` whose dependencies are tarballs in `top/tarballs`, so
// no install reaches the registry: probe-dep 1.0.0 and 2.0.0, and
// scripted-dep, whose install script writes seen.json in its folder with what
// it sees of the environment. The repo approves scripted-dep in
// `allowScripts`, as `npm install-scripts approve` writes it.
// `install(dependencies)` sets the dependencies and runs `npm install` with no
// scripts, as a person does.
async function npmRepository(top: string) {
  const root = join(top, 'repo');
  await mkdir(root);
  const repo = await repository(root, showPackages);
  const environment = isolatedEnvironment(root);
  const npm = (cwd: string, ...args: string[]) =>
    execFileAsync('npm', [...args, '--offline', '--no-audit', '--no-fund'], {
      cwd,
      env: environment,
    });
  const tarball = {
    probe1: await probeTarball(top, environment, {
      name: 'probe-dep',
      version: '1.0.0',
    }),
    probe2: await probeTarball(top, environment, {
      name: 'probe-dep',
      version: '2.0.0',
    }),
    scripted: await probeTarball(top, environment, {
      name: 'scripted-dep',
      version: '1.0.0',
      scripts: {
        install: `node -e "require('fs').writeFileSync('seen.json', JSON.stringify({ index: 'GIT_INDEX_FILE' in process.env, global: process.env.GIT_CONFIG_GLOBAL }))"`,
      },
    }),
  };
  await repo.write('.gitignore', 'node_modules\n');
  const install = async (dependencies: Record<string, string>) => {
    await repo.write(
      'package.json',
      `${JSON.stringify({
        name: 'probe',
        private: true,
        dependencies,
        allowScripts: { [tarball.scripted]: true },
      })}\n`,
    );
    await npm(root, 'install', '--ignore-scripts');
  };
  return { ...repo, tarball, install };
}

test('npm in the install of the staged lockfile gets the tool environment: an install script of a dependency sees no GIT_INDEX_FILE, and the other variables of the hook', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await npmRepository(folder.path);
  await repo.install({ 'scripted-dep': repo.tarball.scripted });
  await repo.git('add', '.gitignore', 'package.json', 'package-lock.json');
  await rm(join(repo.root, 'node_modules'), { recursive: true });

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, installing);
  const seen = shown(result.stderr);
  assert.equal(seen.hookIndex, true, 'git must give the hook GIT_INDEX_FILE');
  assert.deepEqual(seen.seen, { index: false, global: '/dev/null' });
});

test('a snapshot with packages of the staged commit uses the packages of the staged lockfile, not the install of a peer that changed the lockfile and did not stage it', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await npmRepository(folder.path);
  await repo.install({ 'probe-dep': repo.tarball.probe1 });
  await repo.git('add', '.gitignore', 'package.json', 'package-lock.json');
  // A peer installs another version, and does not stage it.
  await repo.install({ 'probe-dep': repo.tarball.probe2 });

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, installing);
  assert.equal(shown(result.stderr).probe, '1.0.0');
});

test('a commit that changes only .npmrc gets a new install, a commit that changes neither the lockfile nor .npmrc uses the install again, and a byte moved from the end of the lockfile to the start of .npmrc makes a new install', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await npmRepository(folder.path);
  await repo.install({ 'probe-dep': repo.tarball.probe1 });
  await rm(join(repo.root, 'node_modules'), { recursive: true });
  const commitWith = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await repo.write(path, content);
      await repo.git('add', path);
    }
    const result = await repo.commit(Object.keys(files).join(' '));
    assert.equal(result.code, 0, result.stderr);
    return result.stderr;
  };
  const lockfile = await readFile(join(repo.root, 'package-lock.json'), 'utf8');
  assert.ok(lockfile.endsWith('\n'));
  await repo.git('add', '.gitignore', 'package.json', 'package-lock.json');
  const first = await commitWith({ '.npmrc': 'fund=false\n' });

  // Act
  const same = await commitWith({ 'notes.txt': 'notes\n' });
  const npmrc = await commitWith({ '.npmrc': 'fund=false\naudit=false\n' });
  const moved = await commitWith({
    'package-lock.json': lockfile.slice(0, -1),
    '.npmrc': '\nfund=false\naudit=false\n',
  });

  // Assert
  assert.match(first, installing);
  assert.doesNotMatch(same, /installing/, 'The same two files use one install');
  assert.match(npmrc, installing, 'A new .npmrc needs a new install');
  assert.match(moved, installing, 'Other files need another install');
  assert.equal(shown(moved).probe, '1.0.0');
});

test('the install has each file of the commit that npm reads: the patch file of patchedDependencies and .npm-extension.cjs', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const root = join(folder.path, 'repo');
  await mkdir(root);
  const repo = await repository(root, showPackages);
  const environment = isolatedEnvironment(root);
  const npm = (...args: string[]) =>
    execFileAsync('npm', [...args, '--no-audit', '--no-fund'], {
      cwd: root,
      env: environment,
    });
  // npm patches only a dependency from a registry. The registry is a port
  // that nothing listens on, and the tarball is in the npm cache, which npm
  // reads by the integrity of the lockfile.
  const source = join(folder.path, 'probe-dep');
  await mkdir(source);
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ name: 'probe-dep', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(join(source, 'index.js'), "exports.v = 'original';\n");
  await execFileAsync(
    'npm',
    ['pack', '--offline', '--pack-destination', folder.path],
    { cwd: source, env: environment },
  );
  const tarball = join(folder.path, 'probe-dep-1.0.0.tgz');
  await repo.write(
    '.npmrc',
    `registry=http://127.0.0.1:9/\ncache=${join(folder.path, 'npm-cache')}\n`,
  );
  await npm('cache', 'add', tarball);
  await repo.write('.gitignore', 'node_modules\n');
  await repo.write(
    'package.json',
    `${JSON.stringify({
      name: 'probe',
      private: true,
      dependencies: { 'probe-dep': '1.0.0' },
      patchedDependencies: {
        'probe-dep@1.0.0': 'patches/probe-dep@1.0.0.patch',
      },
    })}\n`,
  );
  await mkdir(join(root, 'patches'));
  await repo.write(
    'patches/probe-dep@1.0.0.patch',
    "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-exports.v = 'original';\n+exports.v = 'patched';\n",
  );
  await repo.write(
    '.npm-extension.cjs',
    'module.exports = { transformManifest: (manifest) => manifest };\n',
  );
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({
      name: 'probe',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'probe', dependencies: { 'probe-dep': '1.0.0' } },
        'node_modules/probe-dep': {
          version: '1.0.0',
          resolved: 'http://127.0.0.1:9/probe-dep/-/probe-dep-1.0.0.tgz',
          integrity: `sha512-${hash('sha512', await readFile(tarball), 'base64')}`,
        },
      },
    })}\n`,
  );
  // npm records the hash of the patch and of the extension in the lockfile.
  await npm('install');
  await repo.git(
    'add',
    '.gitignore',
    '.npmrc',
    '.npm-extension.cjs',
    'package.json',
    'package-lock.json',
    'patches',
  );
  await rm(join(root, 'node_modules'), { recursive: true });

  // Act
  const result = await repo.commit('patched');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, installing);
  assert.equal(shown(result.stderr).code, "exports.v = 'patched';\n");
});
