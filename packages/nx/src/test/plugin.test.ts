import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test } from '@zukhruf/parameterized-test';

import {
  workspace as temporaryWorkspace,
  zukhrufModules,
} from '../testing/workspace.ts';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/test'));

interface TestTarget {
  executor: string;
  options: { command: string; cwd: string; args?: string };
  outputs: string[];
  cache: boolean;
  dependsOn: string[];
}

// Nx and Vite linked from zukhruf, and the plugin entry in `nx.json`.
const workspace = (
  signal: AbortSignal,
  files: Record<string, string>,
  plugin: string | object = pluginEntry,
) =>
  temporaryWorkspace<TestTarget>({
    files,
    plugins: [plugin],
    links: ['nx', 'vite'],
    packages: {},
    signal,
  });

const packageJson = (name: string, tags: string[] = []) =>
  `${JSON.stringify({ name, version: '0.0.0', nx: { tags } }, null, 2)}\n`;

const passing = (name: string) =>
  `import { test } from 'node:test';\ntest('${name}', () => {});\n`;

const reporters =
  '--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results.xml';

// The script that the command runs, written relative to the project root.
const runner = (workspaceRoot: string, root: string) =>
  `node "${relative(join(workspaceRoot, root), join(dirname(pluginEntry), `run${extname(pluginEntry)}`))}" --test --no-warnings`;

const testCases = (report: string) =>
  [...report.matchAll(/<testcase name="([^"]+)"/g)].map(([, name]) => name);

test('a project that owns test files gets the test target with one glob for each top-level folder', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/deep/x.test.ts': passing('x'),
    'packages/a/src/y.test.mts': passing('y'),
    'packages/a/eval/z.test.ts': passing('z'),
    'packages/a/test/helpers/helper.ts': 'export const helper = 1;\n',
    'packages/b/package.json': packageJson('b'),
    'packages/b/src/index.ts': 'export const value = 1;\n',
    'packages/a/fixtures/inner/project.json': '{ "name": "inner" }\n',
    'packages/a/fixtures/inner/src/i.test.ts': passing('i'),
  });

  const [a, b, inner] = await Promise.all(
    ['a', 'b', 'inner'].map(probe.targets),
  );

  // Nx adds `configurations` and `parallelism` to each target.
  assert.partialDeepStrictEqual(a?.['test'], {
    executor: 'nx:run-commands',
    options: {
      command: `${runner(probe.path, 'packages/a')} --test-timeout=300000 ${reporters} --selection="eval/**/*.test.ts" --selection="src/**/*.test.{mts,ts}" {args}`,
      cwd: 'packages/a',
    },
    outputs: ['{projectRoot}/test-results.xml'],
    cache: false,
    dependsOn: ['^build'],
  });
  assert.equal(a?.['test']?.options.args, undefined);
  assert.equal(b?.['test'], undefined);
  assert.equal(
    inner?.['test']?.options.command,
    `${runner(probe.path, 'packages/a/fixtures/inner')} --test-timeout=300000 ${reporters} --selection="src/**/*.test.ts" {args}`,
  );
});

test('the source plugin runs its source script with the source condition of zukhruf', async (t) => {
  const sourcePlugin = join(import.meta.dirname, 'plugin.ts');
  await using probe = await workspace(
    t.signal,
    {
      'packages/a/package.json': packageJson('a'),
      'packages/a/src/x.test.ts': passing('x'),
    },
    sourcePlugin,
  );

  const targets = await probe.targets('a');

  assert.equal(
    targets['test']?.options.command,
    `node --conditions=@zukhruf/source "${relative(join(probe.path, 'packages/a'), join(import.meta.dirname, 'run.ts'))}" --test --no-warnings --test-timeout=300000 ${reporters} --selection="src/**/*.test.ts" {args}`,
  );
});

test('test files directly in the project root get a glob with no **', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/project.json': '{ "name": "a" }\n',
    'packages/a/root.test.ts': passing('root'),
    'packages/a/src/x.test.ts': passing('x'),
  });

  const targets = await probe.targets('a');

  assert.equal(
    targets['test']?.options.command,
    `${runner(probe.path, 'packages/a')} --test-timeout=300000 ${reporters} --selection="*.test.ts" --selection="src/**/*.test.ts" {args}`,
  );
});

test('a Vitest project gets no test target, and a Vite project without test does', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/vitest/package.json': packageJson('vitest'),
    'packages/vitest/vitest.config.ts': 'export default {};\n',
    'packages/vitest/src/x.test.ts': passing('x'),
    'packages/vite-test/package.json': packageJson('vite-test'),
    'packages/vite-test/vite.config.mjs': 'export default { test: {} };\n',
    'packages/vite-test/src/x.test.ts': passing('x'),
    'packages/vite-app/package.json': packageJson('vite-app'),
    'packages/vite-app/vite.config.mjs': 'export default {};\n',
    'packages/vite-app/src/x.test.ts': passing('x'),
  });

  const shown = await Promise.all(
    ['vitest', 'vite-test', 'vite-app'].map(probe.targets),
  );

  assert.deepEqual(
    shown.map((targets) => targets['test']?.options.command),
    [
      undefined,
      undefined,
      `${runner(probe.path, 'packages/vite-app')} --test-timeout=300000 ${reporters} --selection="src/**/*.test.ts" {args}`,
    ],
  );
});

test('the workspace root and a folder outside the workspaces get no test target', async (t) => {
  await using probe = await workspace(t.signal, {
    'project.json': '{ "name": "probe" }\n',
    'tools/x.test.ts': passing('x'),
    'tools/outside/package.json': packageJson('outside'),
    'tools/outside/x.test.ts': passing('x'),
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/x.test.ts': passing('x'),
  });

  const listed = await probe.nx('show', 'projects', '--withTarget', 'test');

  assert.equal(listed.exitCode, 0, listed.output);
  assert.equal(listed.stdout.trim(), 'a');
});

test('the timeout and flags options change the command, and a Docker flag in flags comes once', async (t) => {
  await using probe = await workspace(
    t.signal,
    {
      'packages/a/package.json': packageJson('a'),
      'packages/a/src/x.test.ts': passing('x'),
      'packages/d/package.json': packageJson('d', ['test:docker']),
      'packages/d/src/testing/docker-global-setup.ts':
        'export const globalSetup = () => {};\n',
      'packages/d/src/x.test.ts': passing('x'),
    },
    {
      plugin: pluginEntry,
      options: {
        timeout: 10_000,
        flags: ['--test-force-exit', '--experimental-test-module-mocks'],
      },
    },
  );

  const shown = await Promise.all(['a', 'd'].map(probe.targets));

  assert.deepEqual(
    shown.map((targets) => targets['test']?.options.command),
    [
      `${runner(probe.path, 'packages/a')} --test-timeout=10000 --test-force-exit --experimental-test-module-mocks ${reporters} --selection="src/**/*.test.ts" {args}`,
      `${runner(probe.path, 'packages/d')} --test-timeout=10000 --test-force-exit --experimental-test-module-mocks --test-global-setup=src/testing/docker-global-setup.ts ${reporters} --selection="src/**/*.test.ts" {args}`,
    ],
  );
});

test('a test:docker project gets its own global setup, else the one of @zukhruf/testing, with force-exit and no cache', async (t) => {
  const testing = join(zukhrufModules, '@zukhruf/testing');
  await using probe = await workspace(t.signal, {
    'packages/own/package.json': packageJson('own', ['test:docker']),
    'packages/own/src/testing/docker-global-setup.ts':
      'export const globalSetup = () => {};\n',
    'packages/own/src/x.test.ts': passing('x'),
    'packages/shared/project.json':
      '{ "name": "shared", "tags": ["test:docker"] }\n',
    'packages/shared/src/x.test.ts': passing('x'),
  });
  await mkdir(join(probe.path, 'node_modules/@zukhruf'));
  await symlink(testing, join(probe.path, 'node_modules/@zukhruf/testing'));
  const packageSetup = relative(
    join(probe.path, 'packages/shared'),
    await realpath(join(testing, 'dist/scripts/docker-global-setup.js')),
  );

  const shown = await Promise.all(['own', 'shared'].map(probe.targets));

  assert.deepEqual(
    shown.map((targets) => [
      targets['test']?.options.command,
      targets['test']?.cache,
    ]),
    [
      [
        `${runner(probe.path, 'packages/own')} --test-timeout=300000 --test-global-setup=src/testing/docker-global-setup.ts --test-force-exit ${reporters} --selection="src/**/*.test.ts" {args}`,
        false,
      ],
      [
        `${runner(probe.path, 'packages/shared')} --test-timeout=300000 --test-global-setup=${packageSetup} --test-force-exit ${reporters} --selection="src/**/*.test.ts" {args}`,
        false,
      ],
    ],
  );
});

test('a test:docker project gets the global setup of @zukhruf/testing before that package is built', async (t) => {
  // Arrange: a fresh checkout, where @zukhruf/testing has its exports but no dist yet.
  const { exports } = JSON.parse(
    await readFile(
      join(zukhrufModules, '@zukhruf/testing/package.json'),
      'utf8',
    ),
  );
  await using probe = await workspace(t.signal, {
    'packages/shared/project.json':
      '{ "name": "shared", "tags": ["test:docker"] }\n',
    'packages/shared/src/x.test.ts': passing('x'),
    'node_modules/@zukhruf/testing/package.json': JSON.stringify({
      name: '@zukhruf/testing',
      type: 'module',
      exports,
    }),
  });

  // Act
  const targets = await probe.targets('shared');

  // Assert: the path the run will find once the build of @zukhruf/testing ran.
  assert.equal(
    targets['test']?.options.command,
    `${runner(probe.path, 'packages/shared')} --test-timeout=300000 --test-global-setup=../../node_modules/@zukhruf/testing/dist/scripts/docker-global-setup.js --test-force-exit ${reporters} --selection="src/**/*.test.ts" {args}`,
  );
});

test('a test:docker project fails the graph when @zukhruf/testing does not resolve', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a', ['test:docker']),
    'packages/a/src/x.test.ts': passing('x'),
  });

  const shown = await probe.nx('show', 'project', 'a', '--json');

  assert.notEqual(shown.exitCode, 0, shown.output);
  assert.match(shown.output, /@zukhruf\/testing\/docker-global-setup/);
});

test('a run narrows with --args, selects by name with a CLI flag, and writes the junit report', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/login.test.ts': passing('login'),
    // Outside the selection, but in Node's own default pattern: its `login`
    // test fails when it runs.
    'packages/a/test/helpers/login.ts':
      "import { test } from 'node:test';\ntest('login', () => { throw new Error('a helper ran'); });\n",
  });

  const narrowed = await probe.nx('run', 'a:test', '--args=src/ok.test.ts');
  const narrowedReport = await probe.read('packages/a/test-results.xml');
  const named = await probe.nx('run', 'a:test', '--test-name-pattern=login');
  const namedReport = await probe.read('packages/a/test-results.xml');

  assert.equal(narrowed.exitCode, 0, narrowed.output);
  assert.deepEqual(testCases(narrowedReport), ['ok']);
  // A file with no test of that name stays in the report as its own
  // test case, so the report lists the files of the selection too.
  assert.equal(named.exitCode, 0, named.output);
  assert.deepEqual(testCases(namedReport), ['login', 'src/ok.test.ts']);
  assert.doesNotMatch(namedReport, /<failure/);
});

test('a test file or a glob after -- narrows the run', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/module.test.mjs': passing('module'),
    'packages/a/src/login.test.ts': passing('login'),
    // Outside the selection, but in Node's own default pattern: its `login`
    // test fails when it runs.
    'packages/a/test/helpers/login.ts':
      "import { test } from 'node:test';\ntest('login', () => { throw new Error('a helper ran'); });\n",
  });

  const file = await probe.nx('run', 'a:test', '--', 'src/ok.test.ts');
  const fileReport = await probe.read('packages/a/test-results.xml');
  const glob = await probe.nx('run', 'a:test', '--', 'src/**/login.test.ts');
  const globReport = await probe.read('packages/a/test-results.xml');
  const module = await probe.nx('run', 'a:test', '--', 'src/module.test.mjs');
  const moduleReport = await probe.read('packages/a/test-results.xml');

  assert.equal(file.exitCode, 0, file.output);
  assert.deepEqual(testCases(fileReport), ['ok']);
  assert.equal(glob.exitCode, 0, glob.output);
  assert.deepEqual(testCases(globReport), ['login']);
  assert.equal(module.exitCode, 0, module.output);
  assert.deepEqual(testCases(moduleReport), ['module']);
});

test('a flag before a file after -- selects by name in that file only', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/login.test.ts': passing('login'),
    // Outside the selection, but in Node's own default pattern: its `login`
    // test fails when it runs.
    'packages/a/test/helpers/login.ts':
      "import { test } from 'node:test';\ntest('login', () => { throw new Error('a helper ran'); });\n",
  });

  const run = await probe.nx(
    'run',
    'a:test',
    '--',
    '--test-name-pattern=login',
    'src/login.test.ts',
  );
  const report = await probe.read('packages/a/test-results.xml');

  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(testCases(report), ['login']);
});

void test.each(
  [
    [
      'after the file',
      ['src/auth.test.ts', '--test-name-pattern=login'],
      ['login'],
    ],
    [
      'after the file, with its value as a separate word',
      ['src/auth.test.ts', '--test-name-pattern', 'login'],
      ['login'],
    ],
    [
      'after the file, another flag',
      ['src/auth.test.ts', '--test-skip-pattern=logout'],
      ['login'],
    ],
    [
      'before the file',
      ['--test-name-pattern=login', 'src/auth.test.ts'],
      ['login'],
    ],
    [
      'between two files',
      [
        'src/auth.test.ts',
        '--test-name-pattern=login',
        'src/ok.test.ts',
        '--test-name-pattern=ok',
      ],
      ['login', 'ok'],
    ],
  ] as const,
  ([where, words, names]) =>
    test(`a flag after -- applies to the files after -- wherever it stands: ${where}`, async (t) => {
      await using probe = await workspace(t.signal, {
        'packages/a/package.json': packageJson('a'),
        'packages/a/src/ok.test.ts': passing('ok'),
        'packages/a/src/auth.test.ts':
          "import { test } from 'node:test';\ntest('login', () => {});\ntest('logout', () => {});\n",
        // Outside the selection, but in Node's own default pattern: its `login`
        // test fails when it runs.
        'packages/a/test/helpers/login.ts':
          "import { test } from 'node:test';\ntest('login', () => { throw new Error('a helper ran'); });\n",
      });

      const run = await probe.nx('run', 'a:test', '--', ...words);
      const report = await probe.read('packages/a/test-results.xml');

      assert.equal(run.exitCode, 0, run.output);
      assert.deepEqual(testCases(report), names);
    }),
);

test('a flag alone keeps the selection: in --args, after -- with its value as a separate word, or with a value that ends like a test file', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/login.test.ts': passing('login'),
    // Outside the selection, but in Node's own default pattern: its `login`
    // test fails when it runs.
    'packages/a/test/helpers/login.ts':
      "import { test } from 'node:test';\ntest('login', () => { throw new Error('a helper ran'); });\n",
  });

  const inArgs = await probe.nx(
    'run',
    'a:test',
    '--args=--test-name-pattern=login',
  );
  const inArgsReport = await probe.read('packages/a/test-results.xml');
  const separate = await probe.nx(
    'run',
    'a:test',
    '--',
    '--test-name-pattern',
    'login',
  );
  const separateReport = await probe.read('packages/a/test-results.xml');
  const fileLike = await probe.nx(
    'run',
    'a:test',
    '--',
    '--test-skip-pattern=none.test.ts',
  );
  const fileLikeReport = await probe.read('packages/a/test-results.xml');

  assert.equal(inArgs.exitCode, 0, inArgs.output);
  assert.deepEqual(testCases(inArgsReport), ['login', 'src/ok.test.ts']);
  assert.doesNotMatch(inArgsReport, /<failure/);
  assert.equal(separate.exitCode, 0, separate.output);
  assert.deepEqual(testCases(separateReport), ['login', 'src/ok.test.ts']);
  assert.doesNotMatch(separateReport, /<failure/);
  assert.equal(fileLike.exitCode, 0, fileLike.output);
  assert.deepEqual(testCases(fileLikeReport), ['login', 'ok']);
  assert.doesNotMatch(fileLikeReport, /<failure/);
});

test('the args of a project with a flag and a glob narrow its run', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': `${JSON.stringify(
      {
        name: 'a',
        version: '0.0.0',
        nx: {
          targets: {
            test: {
              options: { args: '--test-timeout=120000 "src/**/login.test.ts"' },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/login.test.ts': passing('login'),
  });

  const run = await probe.nx('run', 'a:test');
  const report = await probe.read('packages/a/test-results.xml');

  assert.equal(run.exitCode, 0, run.output);
  assert.deepEqual(testCases(report), ['login']);
});

test('a failing test fails the run', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/bad.test.ts':
      "import { test } from 'node:test';\ntest('bad', () => { throw new Error('bad'); });\n",
  });

  const run = await probe.nx('run', 'a:test');
  const report = await probe.read('packages/a/test-results.xml');

  assert.notEqual(run.exitCode, 0, run.output);
  assert.match(report, /<failure/);
});

test('a test:docker run loads its own global setup from the project root', async (t) => {
  await using probe = await workspace(t.signal, {
    'packages/d/package.json': packageJson('d', ['test:docker']),
    'packages/d/src/testing/docker-global-setup.ts':
      "import { writeFileSync } from 'node:fs';\nexport const globalSetup = () => writeFileSync('setup-ran', 'yes');\n",
    'packages/d/src/x.test.ts': passing('x'),
  });

  const run = await probe.nx('run', 'd:test');

  assert.equal(run.exitCode, 0, run.output);
  assert.equal(await probe.read('packages/d/setup-ran'), 'yes');
});
