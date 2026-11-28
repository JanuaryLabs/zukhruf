import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/fs';

import {
  workspace as temporaryWorkspace,
  zukhrufModules,
} from '../testing/workspace.ts';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/lint'));

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

// Nx, `@nx/eslint` and ESLint linked from zukhruf, the plugin entries in
// `nx.json`, and the lockfile entries in `packages`.
const workspace = (
  signal: AbortSignal,
  files: Record<string, string>,
  plugins: (string | object)[],
  packages: Record<string, object>,
) =>
  temporaryWorkspace<{ inputs: unknown[] }>({
    files,
    plugins,
    links: ['nx', 'eslint', '@nx/eslint'],
    packages,
    signal,
  });

const externalInputs = async (
  probe: Awaited<ReturnType<typeof workspace>>,
  task: string,
) => {
  const shown = await probe.nx('show', 'target', 'inputs', task, '--json');
  assert.equal(shown.exitCode, 0, shown.output);
  const inputs: { external: string[] } = JSON.parse(shown.stdout);
  return inputs.external;
};

const packageJson = (name: string) =>
  `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`;

const linted = {
  'eslint.config.mjs': 'export default [{}];\n',
  'packages/a/package.json': packageJson('a'),
  'packages/a/index.js': 'export const value = 1;\n',
  'node_modules/@zukhruf/eslint/package.json': installedManifest,
};

test('lint hashes the peers and dependencies of an installed @zukhruf/eslint and keeps the inputs of @nx/eslint/plugin', async (t) => {
  await using probe = await workspace(
    t.signal,
    linted,
    [eslintEntry, '@zukhruf/nx/lint'],
    installed,
  );
  await symlink(
    join(zukhrufModules, '@zukhruf/nx'),
    join(probe.path, 'node_modules/@zukhruf/nx'),
  );

  const external = await externalInputs(probe, 'a:lint');

  assert.deepEqual(external.sort(), [
    'npm:@zukhruf/eslint',
    'npm:eslint',
    'npm:globals',
    'npm:typescript-eslint',
  ]);
});

test('lint runs again when a peer of @zukhruf/eslint changes its version', async (t) => {
  await using probe = await workspace(
    t.signal,
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

  assert.equal(first.exitCode, 0, first.output);
  assert.match(cached.output, /Nx read the output from the cache/);
  assert.equal(bumped.exitCode, 0, bumped.output);
  assert.doesNotMatch(bumped.output, /Nx read the output from the cache/);
});

test('the plugin stops the graph when it comes before @nx/eslint/plugin, when a second @nx/eslint/plugin entry comes after it, or when no @nx/eslint/plugin entry exists', async (t) => {
  await using first = await workspace(
    t.signal,
    linted,
    [pluginEntry, eslintEntry],
    installed,
  );
  await using second = await workspace(
    t.signal,
    linted,
    [
      { ...eslintEntry, include: ['packages/a/**'] },
      pluginEntry,
      { ...eslintEntry, exclude: ['packages/a/**'] },
    ],
    installed,
  );
  await using third = await workspace(
    t.signal,
    linted,
    [pluginEntry],
    installed,
  );

  const shown = await Promise.all(
    [first, second, third].map((probe) =>
      probe.nx('show', 'project', 'a', '--json'),
    ),
  );

  for (const result of shown) {
    assert.notEqual(result.exitCode, 0, result.output);
    assert.match(
      result.output,
      /List @zukhruf\/nx\/lint after each @nx\/eslint\/plugin entry/,
    );
  }
});

test('the plugin stops the graph when @zukhruf/eslint does not resolve', async (t) => {
  const { 'node_modules/@zukhruf/eslint/package.json': _, ...files } = linted;
  await using probe = await workspace(
    t.signal,
    files,
    [eslintEntry, pluginEntry],
    {},
  );

  const shown = await probe.nx('show', 'project', 'a', '--json');

  assert.notEqual(shown.exitCode, 0, shown.output);
  assert.match(shown.output, /cannot resolve @zukhruf\/eslint/);
});

test('the plugin stops the graph when @zukhruf/eslint is linked from outside the workspace', async (t) => {
  await using outside = await new TemporaryFiles().directory('zukhruf-nx-');
  const { 'node_modules/@zukhruf/eslint/package.json': _, ...files } = linted;
  await using probe = await workspace(
    t.signal,
    files,
    [eslintEntry, pluginEntry],
    {},
  );
  await writeFile(join(outside.path, 'package.json'), installedManifest);
  await mkdir(join(probe.path, 'node_modules/@zukhruf'));
  await symlink(outside.path, join(probe.path, 'node_modules/@zukhruf/eslint'));

  const shown = await probe.nx('show', 'project', 'a', '--json');

  assert.notEqual(shown.exitCode, 0, shown.output);
  assert.match(shown.output, /outside the workspace and outside node_modules/);
});

test('a workspace package @zukhruf/eslint gives its src files and the names of its dependencies and peers', async (t) => {
  const { 'node_modules/@zukhruf/eslint/package.json': _, ...files } = linted;
  await using probe = await workspace(
    t.signal,
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
  await mkdir(join(probe.path, 'node_modules/@zukhruf'));
  await symlink(
    '../../packages/lint-rules',
    join(probe.path, 'node_modules/@zukhruf/eslint'),
  );

  const [targets, external] = await Promise.all([
    probe.targets('a'),
    externalInputs(probe, 'a:lint'),
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

test('a project that @nx/eslint/plugin gives no lint gets no lint, and a custom target name gets the inputs', async (t) => {
  await using probe = await workspace(
    t.signal,
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

test('targetDefaults with "..." adds a lint package to the inputs of both plugins', async (t) => {
  await using probe = await workspace(
    t.signal,
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
    join(probe.path, 'nx.json'),
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

  const external = await externalInputs(probe, 'a:lint');

  assert.deepEqual(external.sort(), [
    'npm:@zukhruf/eslint',
    'npm:eslint',
    'npm:eslint-plugin-no-barrel-files',
    'npm:globals',
    'npm:typescript-eslint',
  ]);
});
