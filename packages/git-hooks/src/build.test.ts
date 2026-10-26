import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

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
  // Starts `git push` with more environment variables for the hook.
  const start = (extra: Record<string, string>, ...args: string[]) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=.husky', 'push', ...args],
      {
        cwd: root,
        env: { ...environment, ...extra },
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = once(child, 'close').then(([code]) => ({
      code: Number(code),
      stderr,
    }));
    return { exited, stderr: () => stderr };
  };
  return {
    top,
    root,
    remote,
    git,
    gitIn,
    write,
    start,
    async commit(message: string) {
      await git('add', '--all');
      await git('commit', '--quiet', '--no-verify', '-m', message);
      return (await git('rev-parse', 'HEAD')).trim();
    },
    push: (...args: string[]) => start({}, ...args).exited,
  };
}

// An Nx workspace of npm, installed the way npm installs it: a real
// node_modules with the workspace links, nx (linked from zukhruf's install,
// since no test may install from the registry), and npm's hidden lockfile.
// The committed package-lock.json matches the install.
//
// Project a is a library with no build. b's build imports @probe/a through
// node_modules, and c's build reads only its own file. A build fails with 30
// error lines when the file that it reads holds BROKEN, and also when it does
// not run with the production configuration. c's lint passes only with
// PROBE_ENV=yes. With PROBE_RECORD, a build writes its folder there; with
// PROBE_GATE, b's build waits for the file `<gate>.release`, and then writes
// `<gate>.done`. With PROBE_AFTER, b's build writes `<gate>.second`, and fails
// unless `<gate>.done` is there: it ran while the gated build had not ended.
async function workspace(folder: string, hook: string) {
  const repo = await repository(folder, hook);
  await repo.write('.gitignore', 'node_modules\n.nx\n');
  await repo.write(
    'package.json',
    '{ "name": "probe", "private": true, "type": "module", "workspaces": ["packages/*"] }\n',
  );
  await repo.write('nx.json', '{}\n');
  await repo.write(
    'tools/build.mjs',
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout } from 'node:timers/promises';
const [project, configuration] = process.argv.slice(2);
if (configuration !== 'production') {
  console.error('not the production configuration');
  process.exit(5);
}
if (process.env.PROBE_RECORD) writeFileSync(process.env.PROBE_RECORD, process.cwd());
const gate = process.env.PROBE_GATE;
if (gate && project === 'b') {
  writeFileSync(\`\${gate}.started\`, '');
  while (!existsSync(\`\${gate}.release\`)) await setTimeout(50);
  writeFileSync(\`\${gate}.done\`, '');
}
const after = process.env.PROBE_AFTER;
if (after && project === 'b') writeFileSync(\`\${after}.second\`, '');
if (after && project === 'b' && !existsSync(\`\${after}.done\`)) {
  console.error('ran while the other build had not ended');
  process.exit(6);
}
const read = project === 'b'
  ? createRequire(\`\${process.cwd()}/packages/b/package.json\`).resolve('@probe/a')
  : \`packages/\${project}/index.js\`;
if (readFileSync(read, 'utf8').includes('BROKEN')) {
  for (let line = 0; line < 30; line++) console.error(\`error \${line} in \${project}\`);
  process.exit(2);
}
console.log(\`built \${project}\`);
`,
  );
  await repo.write(
    'tools/lint.mjs',
    `if (process.env.PROBE_ENV !== 'yes') {
  console.error('PROBE_ENV did not reach the task');
  process.exit(4);
}
`,
  );
  const build = (project: string) => ({
    executor: 'nx:run-commands',
    cache: true,
    options: { command: `node tools/build.mjs ${project}` },
    configurations: {
      production: { command: `node tools/build.mjs ${project} production` },
    },
  });
  const projects: Record<string, object> = {
    a: {},
    b: { build: build('b') },
    c: {
      build: build('c'),
      lint: {
        executor: 'nx:run-commands',
        options: { command: 'node tools/lint.mjs' },
      },
    },
  };
  const nxVersion = '23.2.1';
  const packages: Record<string, object> = {
    'node_modules/nx': { version: nxVersion, license: 'MIT' },
  };
  await mkdir(join(repo.root, 'node_modules/@probe'), { recursive: true });
  for (const [name, targets] of Object.entries(projects)) {
    await repo.write(
      `packages/${name}/package.json`,
      `${JSON.stringify({ name: `@probe/${name}`, version: '0.0.0', type: 'module', nx: { targets } })}\n`,
    );
    await repo.write(`packages/${name}/index.js`, 'export const value = 1;\n');
    packages[`node_modules/@probe/${name}`] = {
      resolved: `packages/${name}`,
      link: true,
    };
    packages[`packages/${name}`] = { name: `@probe/${name}`, version: '0.0.0' };
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

const build = `import { Build, prePush } from '@zukhruf/git-hooks';
await prePush([new Build()]);
`;

test(
  'an uncommitted fix in the working tree does not pass a broken pushed commit',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    await repo.write('packages/c/index.js', 'export const value = "BROKEN";\n');
    const head = await repo.commit('break c');
    await repo.write('packages/c/index.js', 'export const value = 2;\n');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+${head.slice(0, 7)}: 1 of 2 tasks failed: @probe/c:build$`,
        'm',
      ),
    );
    assert.match(result.stderr, /^✖ push stopped by the pre-push hook$/m);
    assert.equal(
      await repo.gitIn(repo.top, '--git-dir', repo.remote, 'rev-list', '--all'),
      '',
      'The remote must get no commit',
    );
  },
);

test(
  'an uncommitted break in a workspace dependency does not block a good push, the build uses the installed packages, and the snapshot is gone after the build',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    const head = await repo.commit('good');
    // b's build reads a through node_modules/@probe/a.
    await repo.write('packages/a/index.js', 'export const value = "BROKEN";\n');
    const record = join(repo.top, 'snapshot-folder');

    // Act
    const result = await repo.start(
      { PROBE_RECORD: record },
      '--quiet',
      'origin',
      'main',
    ).exited;

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+${head.slice(0, 7)}: built 2 projects, 0 of 2 tasks from cache$`,
        'm',
      ),
    );
    assert.doesNotMatch(result.stderr, /installing/, 'No install drift');
    const snapshot = await readFile(record, 'utf8');
    assert.notEqual(snapshot, repo.root, 'The build ran in a snapshot');
    assert.equal(existsSync(snapshot), false, 'The snapshot must be deleted');
    assert.equal(
      (
        await repo.gitIn(
          repo.top,
          '--git-dir',
          repo.remote,
          'rev-parse',
          'main',
        )
      ).trim(),
      head,
    );
  },
);

test(
  'a failing build stops the push, names each failed task, and shows at most 20 lines of the output of each, then the number of the other lines',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    await repo.write('packages/a/index.js', 'export const value = "BROKEN";\n');
    await repo.write('packages/c/index.js', 'export const value = "BROKEN";\n');
    const head = await repo.commit('break b and c');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.notEqual(result.code, 0, result.stderr);
    const header = new RegExp(
      `^build\\s+${head.slice(0, 7)}: 2 of 2 tasks failed: (\\S+), (\\S+)$`,
      'm',
    ).exec(result.stderr);
    assert.ok(header, result.stderr);
    assert.deepEqual([header[1], header[2]].sort(), [
      '@probe/b:build',
      '@probe/c:build',
    ]);
    for (const project of ['b', 'c']) {
      for (let line = 0; line < 20; line++)
        assert.match(
          result.stderr,
          new RegExp(`^ {12}error ${line} in ${project}$`, 'm'),
        );
      assert.doesNotMatch(result.stderr, new RegExp(`error 20 in ${project}`));
      assert.match(
        result.stderr,
        new RegExp(
          `^ {12}@probe/${project}:build\\n {12}error 0 in ${project}$`,
          'm',
        ),
        'The lines of each task come under its name',
      );
    }
    assert.equal(
      result.stderr.match(/^ {12}… 11 more lines$/gm)?.length,
      2,
      'Each failed task gives the number of the lines it does not show',
    );
  },
);

test(
  'a push that only deletes refs is skipped and goes through',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main', 'main:refs/heads/copy');

    // Act
    const result = await repo.push('--quiet', 'origin', '--delete', 'copy');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      /^build\s+skipped: the push only deletes refs$/m,
    );
  },
);

test(
  'a push of a commit that the remote has already is skipped and goes through',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    const head = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main:refs/heads/copy');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+skipped: the remote already has ${head.slice(0, 7)}$`,
        'm',
      ),
    );
  },
);

test(
  'a pushed commit without package-lock.json stops the push with the setup error',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    await rm(join(repo.root, 'package-lock.json'));
    const head = await repo.commit('no lockfile');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+${head.slice(0, 7)} has no package-lock.json; Build works with npm workspaces\\n✖ push stopped by the pre-push hook$`,
        'm',
      ),
    );
  },
);

test(
  'a second pre-push build in the same repo waits for the first, prints that it waits, and both pushes go through',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    const head = await repo.commit('first');
    const second = join(repo.top, 'second.git');
    await repo.gitIn(repo.top, 'init', '--quiet', '--bare', second);
    await repo.git('remote', 'add', 'second', second);
    const gate = join(repo.top, 'gate');
    const first = repo.start({ PROBE_GATE: gate }, '--quiet', 'origin', 'main');
    while (!existsSync(`${gate}.started`)) await delay(50);

    // Act
    const waiting = repo.start(
      { PROBE_AFTER: gate },
      '--quiet',
      'second',
      'main',
    );
    // The gate stays closed until the second build starts its tasks, which
    // it must not do while the first holds the lock, or for 5 s.
    const deadline = performance.now() + 20_000;
    while (
      !waiting.stderr().includes('waiting') &&
      performance.now() < deadline
    )
      await delay(50);
    const grace = performance.now() + 5000;
    while (!existsSync(`${gate}.second`) && performance.now() < grace)
      await delay(50);
    await writeFile(`${gate}.release`, '');
    const [one, two] = await Promise.all([first.exited, waiting.exited]);

    // Assert
    assert.equal(one.code, 0, one.stderr);
    assert.equal(two.code, 0, two.stderr);
    assert.match(
      two.stderr,
      /^build\s+waiting for another pre-push build in this repo$/m,
    );
    assert.match(
      two.stderr,
      new RegExp(`^build\\s+${head.slice(0, 7)}: built 2 projects`, 'm'),
    );
  },
);

test(
  'a push of several refs gives one line for each pushed commit, builds a commit sent to two refs one time, and stops at a failed commit',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    const old = await repo.commit('first');
    await repo.git('push', '--quiet', 'origin', 'main');
    await repo.write('packages/b/notes.md', 'notes\n');
    const good = await repo.commit('second');
    await repo.git('switch', '--quiet', '--create', 'broken');
    await repo.write('packages/c/index.js', 'export const value = "BROKEN";\n');
    const broken = await repo.commit('break c');

    // Act
    const result = await repo.push(
      '--quiet',
      'origin',
      'main',
      'main:refs/heads/also',
      `${old}:refs/heads/copy`,
      'broken',
    );

    // Assert
    assert.notEqual(result.code, 0, result.stderr);
    const lines = result.stderr.split('\n');
    const builtLines = lines.filter((line) =>
      line.includes(`${good.slice(0, 7)}: built`),
    );
    assert.equal(builtLines.length, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^(build| )\\s+skipped: the remote already has ${old.slice(0, 7)}$`,
        'm',
      ),
    );
    assert.match(
      result.stderr,
      new RegExp(
        `^(build| )\\s+${broken.slice(0, 7)}: 1 of 2 tasks failed: @probe/c:build$`,
        'm',
      ),
    );
    assert.equal(
      await repo.gitIn(repo.top, '--git-dir', repo.remote, 'rev-parse', 'main'),
      `${old}\n`,
      'The remote must get none of the refs',
    );
  },
);

test(
  'Build runs its targets with the production configuration and gives env to nx',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(
      folder.path,
      `import { Build, prePush } from '@zukhruf/git-hooks';
await prePush([new Build({ targets: ['lint', 'build'], parallel: 1, env: { PROBE_ENV: 'yes' } })]);
`,
    );
    const head = await repo.commit('first');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+${head.slice(0, 7)}: built 2 projects, 0 of 3 tasks from cache$`,
        'm',
      ),
    );
  },
);

test(
  'a second push gets its unchanged tasks from the nx cache of the state folder, and the .nx folder of the working tree stays absent',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    await repo.commit('first');
    const first = await repo.push('--quiet', 'origin', 'main');
    assert.equal(first.code, 0, first.stderr);
    await repo.write('README.md', 'not an input of a project\n');
    const head = await repo.commit('second');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+${head.slice(0, 7)}: built 2 projects, 2 of 2 tasks from cache$`,
        'm',
      ),
    );
    assert.equal(existsSync(join(repo.root, '.nx')), false);
  },
);

test(
  'nx that fails before it runs a task stops the push with its exit code and its output',
  { timeout: 60_000 },
  async () => {
    // Arrange
    await using folder = await mkdtempDisposable(join(tmpdir(), 'git-hooks-'));
    const repo = await workspace(folder.path, build);
    await repo.write('nx.json', '{ "targetDefaults": \n');
    const head = await repo.commit('break nx.json');

    // Act
    const result = await repo.push('--quiet', 'origin', 'main');

    // Assert
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(
        `^build\\s+${head.slice(0, 7)}: nx exited with \\d+\\n {12}\\S`,
        'm',
      ),
    );
    assert.match(result.stderr, /^✖ push stopped by the pre-push hook$/m);
  },
);
