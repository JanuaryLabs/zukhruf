import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';

import { hookedGit, installHook } from './testing/hooked-repository.ts';
import { repository } from './testing/pre-push-repository.ts';
import { probeTarball } from './testing/probe-tarball.ts';

const execFileAsync = promisify(execFile);

// A repo whose scripts leave a mark in the folder PROBE_MARKS when they run.
async function markingRepository(top: string, hook: string) {
  const marks = join(top, 'marks');
  await mkdir(marks);
  return {
    ...(await repository(top, hook, { PROBE_MARKS: marks })),
    marks,
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
  const repo = await markingRepository(folder, hook);
  const npm = (cwd: string, ...args: string[]) =>
    execFileAsync('npm', [...args, '--offline', '--no-audit', '--no-fund'], {
      cwd,
      env: repo.environment,
    });
  const { top, environment } = repo;
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
        install: `node -e "require('fs').writeFileSync('built.txt', '')"`,
      },
    }),
    extra: await probeTarball(top, environment, {
      name: 'extra-dep',
      version: '1.0.0',
    }),
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
    const seen = await push.snapshot(update.head, { packages: true }).then(async ({ folder }) => {
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

test('a different installed version makes the snapshot use an install of the pushed lockfile, which ran the install scripts of the dependencies and no script of the repo', async () => {
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
});

test('a package that the pushed lockfile names and that is not installed makes the snapshot use an install of the pushed lockfile', async () => {
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
});

test('a repo with no node_modules gets an install of the pushed lockfile', async () => {
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
});

test('an installed package that the pushed lockfile does not name makes the snapshot use an install without it', async () => {
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
});

test('a push with a lockfile that was installed before uses that install, and the hook keeps the two installs that it used last', async () => {
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
});

test('a stray file in the installs folder, such as the .DS_Store of macOS, stays in place, and the prune still deletes an expired install (#4747)', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, inspect);
  const installs = join(repo.root, '.git/git-hooks/installs');
  const pushWith = async (
    dependencies: Record<string, string>,
    note: string,
  ) => {
    await repo.install(dependencies);
    await repo.write('notes.txt', `${note}\n`);
    await repo.commit(note);
    await rm(join(repo.root, 'node_modules'), { recursive: true });
    return repo.push('--quiet', 'origin', 'main');
  };
  const first = await pushWith({ 'probe-dep': repo.tarball.probe1 }, 'one');
  assert.equal(first.code, 0, first.stderr);
  await writeFile(join(installs, '.DS_Store'), '');
  // An install that never finished has no marker, so the prune deletes it.
  await mkdir(join(installs, 'unfinished'));

  // Act
  const result = await pushWith({ 'probe-dep': repo.tarball.probe2 }, 'two');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(installs, '.DS_Store')));
  assert.ok(!existsSync(join(installs, 'unfinished')));
});

test('a push holds a lease on the install that it builds on while its hook runs, and leaves no lease after the hook ends', async (t) => {
  // Arrange: the push has drift, as no packages are installed.
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, gatedInspect);
  await repo.install({ 'probe-dep': repo.tarball.probe1 });
  await repo.commit('one');
  await rm(join(repo.root, 'node_modules'), { recursive: true });
  const installs = join(repo.root, '.git/git-hooks/installs');
  const gate = join(repo.top, 'gate');
  const push = spawn(
    'git',
    ['-c', 'core.hooksPath=.husky', 'push', '--quiet', 'origin', 'main'],
    { cwd: repo.root, env: repo.environment },
  );
  const stderr: string[] = [];
  push.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    push.once('close', resolve),
  );
  try {
    await waitFor(
      () => {
        assert.ok(
          existsSync(`${gate}.started`),
          `The push did not reach its gate:\n${stderr.join('')}`,
        );
      },
      { signal: t.signal, interval: 100 },
    );
    const [install, ...others] = await readdir(installs);
    assert.ok(
      install !== undefined && others.length === 0,
      'The push made one install',
    );
    const leases = join(installs, install, 'leases');
    const duringHook = await readdir(leases);

    // Act
    await writeFile(`${gate}.release`, 'go');
    const code = await exited;

    // Assert
    assert.equal(code, 0, stderr.join(''));
    assert.equal(duringHook.length, 1, 'The hook must hold one lease');
    assert.deepEqual(
      await readdir(leases),
      [],
      'The end of the hook must delete the lease file of its snapshot',
    );
  } finally {
    push.kill();
  }
});

// A pre-push step that opens the snapshot of the head with packages, writes
// `<repo>/../gate.started`, waits for a write to `<repo>/../gate.release`,
// and then reads the version of probe-dep from the node_modules of the
// snapshot.
const gatedInspect = `import { once } from 'node:events';
import { readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Gated extends Step<Push> {
  readonly name = 'inspect';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete') return this.fail('no head');
    const snapshot = await push.snapshot(update.head, { packages: true });
    const gate = join(process.cwd(), '..', 'gate');
    writeFileSync(\`\${gate}.release\`, '');
    const release = watch(\`\${gate}.release\`);
    writeFileSync(\`\${gate}.started\`, '');
    await once(release, 'change');
    release.close();
    const probe = JSON.parse(readFileSync(join(snapshot.folder, 'node_modules/probe-dep/package.json'), 'utf8')).version;
    return this.pass(JSON.stringify({ probe }));
  }
}
await prePush([new Gated()]);
`;

// A pre-commit step that opens the snapshot of the staged tree with packages.
const packagedCommit = `import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
class Packaged extends Step<Commit> {
  readonly name = 'packaged';
  async run(commit: Commit) {
    await commit.snapshot({ packages: true });
    return this.pass('linked');
  }
}
await preCommit([new Packaged()]);
`;

test('while a push builds on an install, commits that install two other lockfiles and prune the installs leave that install in place, and the build ends on its own packages', async (t) => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path, gatedInspect);
  await installHook(repo.root, 'pre-commit', packagedCommit);
  const installs = join(repo.root, '.git/git-hooks/installs');
  const gate = join(repo.top, 'gate');
  // Each change has drift: no packages are installed.
  const stage = async (dependencies: Record<string, string>, note: string) => {
    await repo.install(dependencies);
    await repo.write('notes.txt', `${note}\n`);
    await repo.git('add', '--all');
    await rm(join(repo.root, 'node_modules'), { recursive: true });
  };
  const commitWithHook = async (note: string) => {
    const result = await hookedGit(
      ['-c', 'core.hooksPath=.husky', 'commit', '--quiet', '-m', note],
      { cwd: repo.root, env: repo.environment },
    );
    assert.equal(result.code, 0, result.stderr);
  };
  await stage({ 'probe-dep': repo.tarball.probe1 }, 'one');
  await repo.git('commit', '--quiet', '--no-verify', '-m', 'one');
  const push = spawn(
    'git',
    ['-c', 'core.hooksPath=.husky', 'push', '--quiet', 'origin', 'main'],
    {
      cwd: repo.root,
      env: repo.environment,
    },
  );
  const stderr: string[] = [];
  push.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    push.once('close', resolve),
  );
  try {
    await waitFor(
      () => {
        assert.ok(
          existsSync(`${gate}.started`),
          `The push did not reach its gate:\n${stderr.join('')}`,
        );
      },
      { signal: t.signal, interval: 100 },
    );
    const leased = await readdir(installs);

    // Act
    await stage({ 'probe-dep': repo.tarball.probe2 }, 'two');
    await commitWithHook('two');
    await stage(
      { 'probe-dep': repo.tarball.probe1, 'extra-dep': repo.tarball.extra },
      'three',
    );
    await commitWithHook('three');
    const duringBuild = await readdir(installs);
    await writeFile(`${gate}.release`, 'go');
    const code = await exited;

    // Assert
    assert.equal(leased.length, 1, 'The push made one install');
    assert.ok(
      duringBuild.includes(leased[0] ?? ''),
      `The install that the build uses must stay while it runs: ${duringBuild.join(', ')}`,
    );
    assert.equal(
      duringBuild.length,
      3,
      'The two commits made two more installs',
    );
    assert.equal(code, 0, stderr.join(''));
    assert.match(stderr.join(''), /^inspect\s+\{"probe":"1\.0\.0"\}$/m);
  } finally {
    push.kill();
  }
});

test('an install that fails stops the push with the reason npm gave, and the next push installs that lockfile again', async () => {
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
});

// A repo whose root depends on shim-dep from the folder vendor/shim-dep
// (`file:`), which is not a workspace package, as a repo vendors a fixed copy
// of a package. npm links node_modules/shim-dep to vendor/shim-dep.
// carrier-dep, a tarball in the temp folder, depends on shim-dep and reads it
// from its own folder in node_modules. The step requires carrier-dep in
// the snapshot of the pushed commit, and shows the value that it reads through
// the link. `vendor(value)` writes the folder with that value.
async function vendored(folder: string) {
  const repo = await markingRepository(
    folder,
    `import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Inspect extends Step<Push> {
  readonly name = 'inspect';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete') return this.fail('no head');
    const seen = await push.snapshot(update.head, { packages: true }).then(async ({ folder }) =>
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
  const { top, environment } = repo;
  const tarball = {
    carrier: await probeTarball(
      top,
      environment,
      {
        name: 'carrier-dep',
        version: '1.0.0',
        dependencies: { 'shim-dep': '^1.0.0' },
      },
      `exports.value = require('shim-dep').value;\n`,
    ),
    leaf1: await probeTarball(top, environment, {
      name: 'leaf-dep',
      version: '1.0.0',
    }),
    leaf2: await probeTarball(top, environment, {
      name: 'leaf-dep',
      version: '2.0.0',
    }),
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

test('a package that the pushed lockfile links to a folder outside the workspaces reads that folder of the pushed commit from an install of the lockfile', async () => {
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
});

test('a push that changes a linked folder outside the workspaces and keeps the lockfile reads the new folder through the install of the lockfile', async () => {
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
});

test('a pushed lockfile that names a workspace that .gitignore names, so the commit does not have it, installs, and the next push uses that install again (#4193)', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type Push, Step, prePush } from '@zukhruf/git-hooks';
class Inspect extends Step<Push> {
  readonly name = 'inspect';
  async run(push: Push) {
    const [update] = push.updates;
    if (update === undefined || update.kind === 'delete') return this.fail('no head');
    const seen = await push.snapshot(update.head, { packages: true }).then(async ({ folder }) => ({
      workspace: realpathSync(join(folder, 'node_modules/@probe/ws')) === join(folder, 'packages/ws'),
      ignored: existsSync(join(folder, '.evals')),
    })).catch((error: Error) => error);
    if (seen instanceof Error) return this.fail(seen.message.trimEnd());
    return this.pass(JSON.stringify(seen));
  }
}
await prePush([new Inspect()]);
`,
  );
  await repo.write('.gitignore', 'node_modules\n.evals\n');
  await repo.write(
    'package.json',
    `${JSON.stringify({ name: 'probe', private: true, workspaces: ['packages/*', '.evals'] })}\n`,
  );
  await repo.write(
    'packages/ws/package.json',
    `${JSON.stringify({ name: '@probe/ws', version: '0.0.0' })}\n`,
  );
  // A workspace of this working tree only, which the lockfile records.
  await repo.write(
    '.evals/package.json',
    `${JSON.stringify({ name: '@probe/evals', version: '0.0.0' })}\n`,
  );
  await execFileAsync(
    'npm',
    ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'],
    { cwd: repo.root, env: repo.environment },
  );
  assert.match(
    await readFile(join(repo.root, 'package-lock.json'), 'utf8'),
    /"resolved": "\.evals"/,
  );
  const head = await repo.commit('a workspace that .gitignore names');
  await rm(join(repo.root, 'node_modules'), { recursive: true });

  // Act
  const installed = await repo.push('--quiet', 'origin', 'main');
  await repo.write('notes.txt', 'notes\n');
  await repo.commit('notes');
  const reused = await repo.push('--quiet', 'origin', 'main');

  // Assert
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stderr, installing(head));
  assert.deepEqual(seen(installed.stderr), { workspace: true, ignored: false });
  assert.equal(reused.code, 0, reused.stderr);
  assert.doesNotMatch(reused.stderr, /installing/, 'The install is used again');
  assert.deepEqual(seen(reused.stderr), { workspace: true, ignored: false });
});
