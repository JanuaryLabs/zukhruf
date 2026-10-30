import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/testing/fs';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/lint'));
const zukhrufModules = fileURLToPath(
  new URL('../../../../node_modules', import.meta.url),
);
const nxBin = join(zukhrufModules, 'nx/dist/bin/nx.js');

const eslintEntry = { plugin: '@nx/eslint/plugin' };

// The lockfile entries of an installed `@zukhruf/eslint` with one peer and
// one dependency. Nx reads the edges and the hashes of a package only from
// the lockfile (`npm-parser.js:103,155-170`).
const installed = {
  'node_modules/@zukhruf/eslint': {
    version: '0.3.58',
    license: 'MIT',
    dependencies: { globals: '^17.13.0' },
    peerDependencies: { 'typescript-eslint': '^8.47.0' },
  },
  'node_modules/globals': {
    version: '17.13.0',
    license: 'MIT',
    integrity: 'sha512-globals',
  },
  'node_modules/typescript-eslint': { version: '8.47.0', license: 'MIT' },
};

const installedManifest = `${JSON.stringify({
  name: '@zukhruf/eslint',
  version: '0.3.58',
  dependencies: { globals: '^17.13.0' },
  peerDependencies: { 'typescript-eslint': '^8.47.0' },
})}\n`;

// An npm workspace in a temp folder with `packages/*` as its workspace globs,
// Nx, `@nx/eslint` and ESLint linked from zukhruf, the plugin entries in
// `nx.json`, and the lockfile entries in `packages`. Nx sees none of the
// user's config and no environment of the Nx task that runs this test.
async function workspace(
  root: string,
  files: Record<string, string>,
  plugins: (string | object)[],
  packages: Record<string, object>,
) {
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write(
    'package.json',
    '{ "name": "probe", "private": true, "workspaces": ["packages/*"] }\n',
  );
  await write(
    'nx.json',
    `${JSON.stringify({ useDaemonProcess: false, plugins })}\n`,
  );
  for (const [path, content] of Object.entries(files)) {
    await write(path, content);
  }
  await mkdir(join(root, 'home'));
  await mkdir(join(root, 'node_modules/.bin'), { recursive: true });
  await mkdir(join(root, 'node_modules/@nx'));
  for (const name of ['nx', 'eslint', '@nx/eslint']) {
    await symlink(join(zukhrufModules, name), join(root, 'node_modules', name));
  }
  await symlink(
    '../eslint/bin/eslint.js',
    join(root, 'node_modules/.bin/eslint'),
  );
  const lockfile = (lockfilePackages: Record<string, object>) =>
    write(
      'package-lock.json',
      `${JSON.stringify(
        {
          name: 'probe',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'probe', workspaces: ['packages/*'] },
            'node_modules/nx': { version: '23.2.1', license: 'MIT' },
            'node_modules/eslint': { version: '10.12.0', license: 'MIT' },
            ...lockfilePackages,
          },
        },
        null,
        2,
      )}\n`,
    );
  await lockfile(packages);
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
  };
  const nx = async (...args: string[]) => {
    const child = spawn(process.execPath, [nxBin, ...args], {
      cwd: root,
      env: environment,
      timeout: 60_000,
    });
    const stdoutChunks = child.stdout.toArray();
    const stderrChunks = child.stderr.toArray();
    const [code] = await once(child, 'close');
    const stdout = Buffer.concat(await stdoutChunks).toString();
    const stderr = Buffer.concat(await stderrChunks).toString();
    return { code, stdout, output: stdout + stderr };
  };
  const targets = async (project: string) => {
    const shown = await nx('show', 'project', project, '--json');
    assert.equal(shown.code, 0, shown.output);
    const configuration: {
      targets: Record<string, { inputs: unknown[] }>;
    } = JSON.parse(shown.stdout);
    return configuration.targets;
  };
  const external = async (task: string) => {
    const shown = await nx('show', 'target', 'inputs', task, '--json');
    assert.equal(shown.code, 0, shown.output);
    const inputs: { external: string[] } = JSON.parse(shown.stdout);
    return inputs.external;
  };
  return {
    nx,
    targets,
    external,
    lockfile,
    read: (path: string) => readFile(join(root, path)).then(String),
  };
}

const packageJson = (name: string) =>
  `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`;

const linted = {
  'eslint.config.mjs': 'export default [{}];\n',
  'packages/a/package.json': packageJson('a'),
  'packages/a/index.js': 'export const value = 1;\n',
  'node_modules/@zukhruf/eslint/package.json': installedManifest,
};

test('lint hashes the peers and dependencies of an installed @zukhruf/eslint and keeps the inputs of @nx/eslint/plugin', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(
    folder.path,
    linted,
    [eslintEntry, '@zukhruf/nx/lint'],
    installed,
  );
  await symlink(
    join(zukhrufModules, '@zukhruf/nx'),
    join(folder.path, 'node_modules/@zukhruf/nx'),
  );

  const external = await probe.external('a:lint');

  assert.deepEqual(external.sort(), [
    'npm:@zukhruf/eslint',
    'npm:eslint',
    'npm:globals',
    'npm:typescript-eslint',
  ]);
});

test('lint runs again when a peer of @zukhruf/eslint changes its version', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(
    folder.path,
    linted,
    [eslintEntry, pluginEntry],
    installed,
  );
  const first = await probe.nx('run', 'a:lint');
  const cached = await probe.nx('run', 'a:lint');

  await probe.lockfile({
    ...installed,
    'node_modules/typescript-eslint': { version: '8.48.0', license: 'MIT' },
  });
  const bumped = await probe.nx('run', 'a:lint');

  assert.equal(first.code, 0, first.output);
  assert.match(cached.output, /Nx read the output from the cache/);
  assert.equal(bumped.code, 0, bumped.output);
  assert.doesNotMatch(bumped.output, /Nx read the output from the cache/);
});

test('the plugin stops the graph when it comes before @nx/eslint/plugin, when a second @nx/eslint/plugin entry comes after it, or when no @nx/eslint/plugin entry exists', async () => {
  await using before = await new TemporaryFiles().directory('zukhruf-nx-');
  await using between = await new TemporaryFiles().directory('zukhruf-nx-');
  await using alone = await new TemporaryFiles().directory('zukhruf-nx-');
  const first = await workspace(
    before.path,
    linted,
    [pluginEntry, eslintEntry],
    installed,
  );
  const second = await workspace(
    between.path,
    linted,
    [
      { ...eslintEntry, include: ['packages/a/**'] },
      pluginEntry,
      { ...eslintEntry, exclude: ['packages/a/**'] },
    ],
    installed,
  );
  const third = await workspace(alone.path, linted, [pluginEntry], installed);

  const shown = await Promise.all(
    [first, second, third].map((probe) =>
      probe.nx('show', 'project', 'a', '--json'),
    ),
  );

  for (const result of shown) {
    assert.notEqual(result.code, 0, result.output);
    assert.match(
      result.output,
      /List @zukhruf\/nx\/lint after each @nx\/eslint\/plugin entry/,
    );
  }
});

test('the plugin stops the graph when @zukhruf/eslint does not resolve', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const { 'node_modules/@zukhruf/eslint/package.json': _, ...files } = linted;
  const probe = await workspace(
    folder.path,
    files,
    [eslintEntry, pluginEntry],
    {},
  );

  const shown = await probe.nx('show', 'project', 'a', '--json');

  assert.notEqual(shown.code, 0, shown.output);
  assert.match(shown.output, /cannot resolve @zukhruf\/eslint/);
});

test('the plugin stops the graph when @zukhruf/eslint is linked from outside the workspace', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  await using outside = await new TemporaryFiles().directory('zukhruf-nx-');
  const { 'node_modules/@zukhruf/eslint/package.json': _, ...files } = linted;
  const probe = await workspace(
    folder.path,
    files,
    [eslintEntry, pluginEntry],
    {},
  );
  await writeFile(join(outside.path, 'package.json'), installedManifest);
  await mkdir(join(folder.path, 'node_modules/@zukhruf'));
  await symlink(
    outside.path,
    join(folder.path, 'node_modules/@zukhruf/eslint'),
  );

  const shown = await probe.nx('show', 'project', 'a', '--json');

  assert.notEqual(shown.code, 0, shown.output);
  assert.match(shown.output, /outside the workspace and outside node_modules/);
});

test('a workspace package @zukhruf/eslint gives its src files and the names of its dependencies and peers', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const { 'node_modules/@zukhruf/eslint/package.json': _, ...files } = linted;
  const probe = await workspace(
    folder.path,
    { ...files, 'packages/lint-rules/package.json': installedManifest },
    [eslintEntry, pluginEntry],
    {
      'node_modules/@zukhruf/eslint': {
        resolved: 'packages/lint-rules',
        link: true,
      },
      'node_modules/globals': installed['node_modules/globals'],
      'node_modules/typescript-eslint':
        installed['node_modules/typescript-eslint'],
    },
  );
  await mkdir(join(folder.path, 'node_modules/@zukhruf'));
  await symlink(
    '../../packages/lint-rules',
    join(folder.path, 'node_modules/@zukhruf/eslint'),
  );

  const [targets, external] = await Promise.all([
    probe.targets('a'),
    probe.external('a:lint'),
  ]);

  assert.deepEqual(targets['lint']?.inputs.slice(-2), [
    '{workspaceRoot}/packages/lint-rules/src/**/*',
    { externalDependencies: ['globals', 'typescript-eslint'] },
  ]);
  assert.deepEqual(external.sort(), [
    'npm:eslint',
    'npm:globals',
    'npm:typescript-eslint',
  ]);
});

test('a project that @nx/eslint/plugin gives no lint gets no lint, and a custom target name gets the inputs', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(
    folder.path,
    {
      'packages/a/package.json': packageJson('a'),
      'packages/a/index.js': 'export const value = 1;\n',
      'packages/a/eslint.config.mjs': 'export default [{}];\n',
      'packages/b/package.json': packageJson('b'),
      'packages/b/index.js': 'export const value = 1;\n',
      'node_modules/@zukhruf/eslint/package.json': installedManifest,
    },
    [{ ...eslintEntry, options: { targetName: 'eslint' } }, pluginEntry],
    installed,
  );

  const [a, b] = await Promise.all(['a', 'b'].map(probe.targets));

  assert.equal(a?.['lint'], undefined);
  assert.deepEqual(a?.['eslint']?.inputs.at(-1), {
    externalDependencies: ['@zukhruf/eslint'],
  });
  assert.deepEqual(
    Object.keys(b ?? {}).filter((name) => name.includes('lint')),
    [],
  );
});

test('targetDefaults with "..." adds a lint package to the inputs of both plugins', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(
    folder.path,
    linted,
    [eslintEntry, pluginEntry],
    {
      ...installed,
      'node_modules/eslint-plugin-no-barrel-files': {
        version: '1.2.2',
        license: 'MIT',
      },
    },
  );
  const nxJson = JSON.parse(await probe.read('nx.json'));
  await writeFile(
    join(folder.path, 'nx.json'),
    `${JSON.stringify({
      ...nxJson,
      targetDefaults: {
        lint: {
          inputs: [
            '...',
            { externalDependencies: ['eslint-plugin-no-barrel-files'] },
          ],
        },
      },
    })}\n`,
  );

  const external = await probe.external('a:lint');

  assert.deepEqual(external.sort(), [
    'npm:@zukhruf/eslint',
    'npm:eslint',
    'npm:eslint-plugin-no-barrel-files',
    'npm:globals',
    'npm:typescript-eslint',
  ]);
});
