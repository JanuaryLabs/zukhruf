import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { workspace as temporaryWorkspace } from '../testing/workspace.ts';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/format'));

const formatted = 'export const value = 1;\n';
const unformatted = 'export const   value=1\n';

// Nx and Prettier linked from zukhruf, and the plugin entry in `nx.json`.
const workspace = (
  root: string,
  files: Record<string, string>,
  plugin: string | object = pluginEntry,
) =>
  temporaryWorkspace<{ options: { command: string } }>({
    root,
    files,
    plugins: [plugin],
    links: ['nx', 'prettier'],
    packages: {},
  });

const packageJson = (name: string) =>
  `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`;

test('each workspace project gets format and format:check', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a'),
    'packages/b/project.json': '{ "name": "b" }\n',
    'packages/c/package.json': packageJson('c'),
    'packages/c/project.json': '{ "name": "c" }\n',
  });

  const shown = await Promise.all(['a', 'b', 'c'].map(probe.targets));

  assert.deepEqual(
    shown.map((targets) =>
      [targets['format'], targets['format:check']].map(
        (target) => target?.options.command,
      ),
    ),
    ['a', 'b', 'c'].map((project) => [
      `prettier --write packages/${project}`,
      `prettier --check packages/${project}`,
    ]),
  );
});

test('no folder outside the projects of Nx becomes a project', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(
    folder.path,
    {
      'packages/a/package.json': packageJson('a'),
      'packages/a/fixtures/inside/package.json': packageJson('inside'),
      'tools/outside/package.json': packageJson('outside'),
      'packages/excluded/package.json': packageJson('excluded'),
    },
    { plugin: pluginEntry, exclude: ['packages/excluded/**'] },
  );

  const listed = await probe.nx('show', 'projects', '--json');
  const excluded = await probe.targets('excluded');

  assert.equal(listed.code, 0, listed.output);
  const projects: string[] = JSON.parse(listed.stdout);
  assert.deepEqual(projects.sort(), ['a', 'excluded']);
  assert.deepEqual(
    Object.keys(excluded).filter((name) => name.startsWith('format')),
    [],
  );
});

test('format:check fails on an unformatted file and leaves it as it was', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/index.ts': unformatted,
  });

  const run = await probe.nx('run', 'a:format:check', '--skip-nx-cache');

  assert.notEqual(run.code, 0, run.output);
  assert.match(run.output, /packages\/a\/index\.ts/);
  assert.equal(await probe.read('packages/a/index.ts'), unformatted);
});

test('format:check runs again when the Prettier config changes', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/index.ts': 'export const value = "a";\n',
    'prettier.config.mjs': 'export default { singleQuote: false };\n',
  });
  const first = await probe.nx('run', 'a:format:check');

  await probe.write(
    'prettier.config.mjs',
    'export default { singleQuote: true };\n',
  );
  const second = await probe.nx('run', 'a:format:check');

  assert.equal(first.code, 0, first.output);
  assert.notEqual(second.code, 0, second.output);
  assert.match(second.output, /packages\/a\/index\.ts/);
});

test('format:check reads the Prettier plugins that the config names', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a'),
    '.prettierrc': `${JSON.stringify({ plugins: ['@trivago/prettier-plugin-sort-imports'] })}\n`,
  });

  const shown = await probe.nx('show', 'project', 'a', '--json');

  const configuration: {
    targets: { 'format:check': { inputs: unknown[] } };
  } = JSON.parse(shown.stdout);
  assert.deepEqual(
    configuration.targets['format:check'].inputs.filter(
      (input) => typeof input === 'object',
    ),
    [
      {
        externalDependencies: [
          'prettier',
          '@trivago/prettier-plugin-sort-imports',
        ],
      },
    ],
  );
});

test('a project.json target replaces the inferred target', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/project.json': `${JSON.stringify({
      name: 'a',
      targets: { 'format:check': { command: 'tofu fmt -check -recursive' } },
    })}\n`,
  });

  const targets = await probe.targets('a');

  assert.deepEqual(targets['format:check']?.options, {
    command: 'tofu fmt -check -recursive',
  });
});

test('format writes the formatted file', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/a/package.json': packageJson('a'),
    'packages/a/index.ts': unformatted,
  });

  const run = await probe.nx('run', 'a:format');

  assert.equal(run.code, 0, run.output);
  assert.equal(await probe.read('packages/a/index.ts'), formatted);
});
