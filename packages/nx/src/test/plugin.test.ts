import assert from 'node:assert/strict';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  workspace as temporaryWorkspace,
  zukhrufModules,
} from '../testing/workspace.ts';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/test'));

interface TestTarget {
  executor: string;
  options: { command: string; cwd: string; args: string };
  outputs: string[];
  cache: boolean;
  dependsOn: string[];
}

// Nx and Vite linked from zukhruf, and the plugin entry in `nx.json`.
const workspace = (
  root: string,
  files: Record<string, string>,
  plugin: string | object = pluginEntry,
) =>
  temporaryWorkspace<TestTarget>({
    root,
    files,
    plugins: [plugin],
    links: ['nx', 'vite'],
    packages: {},
  });

const packageJson = (name: string, tags: string[] = []) =>
  `${JSON.stringify({ name, version: '0.0.0', nx: { tags } }, null, 2)}\n`;

const passing = (name: string) =>
  `import { test } from 'node:test';\ntest('${name}', () => {});\n`;

const reporters =
  '--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=test-results.xml {args}';

test('a project that owns test files gets the test target with one glob for each top-level folder', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
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
      command: `node --test --no-warnings --test-timeout=60000 ${reporters}`,
      cwd: 'packages/a',
      args: '"eval/**/*.test.ts" "src/**/*.test.{mts,ts}"',
    },
    outputs: ['{projectRoot}/test-results.xml'],
    cache: false,
    dependsOn: ['^build'],
  });
  assert.equal(b?.['test'], undefined);
  assert.equal(inner?.['test']?.options.args, '"src/**/*.test.ts"');
});

test('test files directly in the project root get a glob with no **', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/project.json': '{ "name": "a" }\n',
    'packages/a/root.test.ts': passing('root'),
    'packages/a/src/x.test.ts': passing('x'),
  });

  const targets = await probe.targets('a');

  assert.equal(targets['test']?.options.args, '"*.test.ts" "src/**/*.test.ts"');
});

test('a Vitest project gets no test target, and a Vite project without test does', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
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
    shown.map((targets) => targets['test']?.options.args),
    [undefined, undefined, '"src/**/*.test.ts"'],
  );
});

test('the workspace root and a folder outside the workspaces get no test target', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'project.json': '{ "name": "probe" }\n',
    'tools/x.test.ts': passing('x'),
    'tools/outside/package.json': packageJson('outside'),
    'tools/outside/x.test.ts': passing('x'),
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/x.test.ts': passing('x'),
  });

  const listed = await probe.nx('show', 'projects', '--withTarget', 'test');

  assert.equal(listed.code, 0, listed.output);
  assert.equal(listed.stdout.trim(), 'a');
});

test('the timeout and flags options change the command, and a Docker flag in flags comes once', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(
    folder.path,
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
      `node --test --no-warnings --test-timeout=10000 --test-force-exit --experimental-test-module-mocks ${reporters}`,
      `node --test --no-warnings --test-timeout=10000 --test-force-exit --experimental-test-module-mocks --test-global-setup=src/testing/docker-global-setup.ts ${reporters}`,
    ],
  );
});

test('a test:docker project gets its own global setup, else the one of @zukhruf/testing, with force-exit and no cache', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const testing = join(zukhrufModules, '@zukhruf/testing');
  const probe = await workspace(folder.path, {
    'packages/own/package.json': packageJson('own', ['test:docker']),
    'packages/own/src/testing/docker-global-setup.ts':
      'export const globalSetup = () => {};\n',
    'packages/own/src/x.test.ts': passing('x'),
    'packages/shared/project.json':
      '{ "name": "shared", "tags": ["test:docker"] }\n',
    'packages/shared/src/x.test.ts': passing('x'),
  });
  await mkdir(join(folder.path, 'node_modules/@zukhruf'));
  await symlink(testing, join(folder.path, 'node_modules/@zukhruf/testing'));
  const packageSetup = relative(
    join(folder.path, 'packages/shared'),
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
        `node --test --no-warnings --test-timeout=60000 --test-global-setup=src/testing/docker-global-setup.ts --test-force-exit ${reporters}`,
        false,
      ],
      [
        `node --test --no-warnings --test-timeout=60000 --test-global-setup=${packageSetup} --test-force-exit ${reporters}`,
        false,
      ],
    ],
  );
});

test('a test:docker project fails the graph when @zukhruf/testing does not resolve', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a', ['test:docker']),
    'packages/a/src/x.test.ts': passing('x'),
  });

  const shown = await probe.nx('show', 'project', 'a', '--json');

  assert.notEqual(shown.code, 0, shown.output);
  assert.match(shown.output, /@zukhruf\/testing\/docker-global-setup/);
});

test('a run narrows with --args, selects by name with a CLI flag, and writes the junit report', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/src/ok.test.ts': passing('ok'),
    'packages/a/src/login.test.ts': passing('login'),
    'packages/a/test/helpers/login.ts':
      "import { test } from 'node:test';\ntest('login', () => { throw new Error('a helper ran'); });\n",
  });

  const narrowed = await probe.nx('run', 'a:test', '--args=src/ok.test.ts');
  const narrowedReport = await probe.read('packages/a/test-results.xml');
  const named = await probe.nx('run', 'a:test', '--test-name-pattern=login');
  const namedReport = await probe.read('packages/a/test-results.xml');

  assert.equal(narrowed.code, 0, narrowed.output);
  assert.deepEqual(
    [...narrowedReport.matchAll(/<testcase name="([^"]+)"/g)].map(
      ([, name]) => name,
    ),
    ['ok'],
  );
  // A file with no test of that name stays in the report as its own
  // test case, so the report lists the files of the selection too. The
  // helper outside the selection fails its `login` test when it runs.
  assert.equal(named.code, 0, named.output);
  assert.deepEqual(
    [...namedReport.matchAll(/<testcase name="([^"]+)"/g)].map(
      ([, name]) => name,
    ),
    ['login', 'src/ok.test.ts'],
  );
  assert.doesNotMatch(namedReport, /<failure/);
});

test('a test:docker run loads its own global setup from the project root', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/d/package.json': packageJson('d', ['test:docker']),
    'packages/d/src/testing/docker-global-setup.ts':
      "import { writeFileSync } from 'node:fs';\nexport const globalSetup = () => writeFileSync('setup-ran', 'yes');\n",
    'packages/d/src/x.test.ts': passing('x'),
  });

  const run = await probe.nx('run', 'd:test');

  assert.equal(run.code, 0, run.output);
  assert.equal(await probe.read('packages/d/setup-ran'), 'yes');
});
