import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { nxVersion, zukhrufVersion } from '../versions.ts';
import initGenerator from './generator.ts';

/** A workspace with the root package name `name`, and no formatter config. */
function workspace(name = '@acme/source'): Tree {
  const tree = createTreeWithEmptyWorkspace({ formatter: 'none' });
  tree.delete('tsconfig.base.json');
  writeJson(tree, 'package.json', {
    name,
    dependencies: {},
    devDependencies: {},
  });
  return tree;
}

test('the sort-imports config groups the imports of the workspace scope', async () => {
  const tree = workspace('@acme/source');

  await initGenerator(tree);

  assert.deepEqual(readJson(tree, '.prettierrc').importOrder, [
    '^\\./env(\\.ts)?$',
    '^\\./startup(\\.ts)?$',
    '^node:(.*)$',
    '<THIRD_PARTY_MODULES>',
    '^@acme/(.*)$',
    '^[./]',
  ]);
});

test('a root package name with no scope stops the generator', async () => {
  const tree = workspace('acme');

  await assert.rejects(initGenerator(tree), /"acme" has no scope/);
});

test('a fresh workspace gets each root file of the standard', async () => {
  const tree = workspace();

  await initGenerator(tree);

  for (const path of [
    'tsconfig.base.json',
    'tsconfig.json',
    '.npmrc',
    '.nvmrc',
    '.gitattributes',
    '.editorconfig',
    '.gitignore',
    '.prettierrc',
    '.prettierignore',
    'eslint.config.mjs',
    '.husky/pre-commit.ts',
    '.husky/pre-push.ts',
    '.husky/commit-msg.ts',
    '.vscode/settings.json',
    '.vscode/extensions.json',
    'AGENTS.md',
    'CLAUDE.md',
  ]) {
    assert.ok(tree.exists(path), path);
  }
  const packageJson = readJson(tree, 'package.json');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.deepEqual(packageJson.workspaces, ['apps/*', 'packages/*', 'tools/*']);
  assert.deepEqual(packageJson.scripts, {
    prepare: 'git config core.hooksPath .husky || exit 0',
  });
  assert.equal(
    packageJson.devDependencies['@typescript/native'],
    'npm:typescript@7.0.2',
  );
  assert.equal(
    packageJson.devDependencies['typescript'],
    'npm:@typescript/typescript6@6.0.2',
  );
  for (const name of ['@zukhruf/eslint', '@zukhruf/git-hooks', '@zukhruf/nx']) {
    assert.equal(packageJson.devDependencies[name], zukhrufVersion, name);
  }
  assert.deepEqual(packageJson.allowScripts, {
    nx: false,
    'unrs-resolver': false,
  });
  assert.match(tree.read('.npmrc', 'utf-8') ?? '', /^legacy-peer-deps=false$/m);
  assert.match(tree.read('.npmrc', 'utf-8') ?? '', /^save-exact=true$/m);
  assert.match(
    tree.read('.npmrc', 'utf-8') ?? '',
    /^strict-allow-scripts=true$/m,
  );
  assert.equal(tree.read('.nvmrc', 'utf-8'), 'lts/*\n');
  assert.equal(
    readJson(tree, 'tsconfig.base.json').compilerOptions.moduleResolution,
    'Bundler',
  );
  assert.equal(tree.read('CLAUDE.md', 'utf-8'), '@AGENTS.md\n');
  const nxJson = readJson(tree, 'nx.json');
  assert.equal(nxJson.analytics, false);
  assert.deepEqual(nxJson.tui, { enabled: false });
  assert.deepEqual(nxJson.namedInputs.production.at(-1), { env: 'NODE_ENV' });
  assert.deepEqual(
    nxJson.plugins.map((entry: string | { plugin: string }) =>
      typeof entry === 'string' ? entry : entry.plugin,
    ),
    [
      '@nx/js/typescript',
      '@nx/eslint/plugin',
      '@zukhruf/nx/lint',
      '@zukhruf/nx/format',
      '@zukhruf/nx/test',
    ],
  );
  assert.deepEqual(nxJson.targetDefaults.typecheck.dependsOn, [
    'lint',
    'format:check',
    '...',
  ]);
  assert.equal(nxJson.sync.applyChanges, true);
  const preCommit = tree.read('.husky/pre-commit.ts', 'utf-8') ?? '';
  assert.match(preCommit, /^#!\/usr\/bin\/env node\n/);
  assert.match(preCommit, /new Format\(\)/);
  assert.match(
    preCommit,
    /new LockfileSync\(\),\n {2}new OneRuntimeCopy\(\),\n {2}new InstallScriptsReviewed\(\),\n/,
  );
  assert.match(
    tree.read('.husky/pre-push.ts', 'utf-8') ?? '',
    /prePush\(\[new Build\(\{ env: \{ NODE_ENV: 'production' \} \}\)\]\)/,
  );
  assert.match(
    tree.read('.husky/commit-msg.ts', 'utf-8') ?? '',
    /commitMsg\(\[new NxReleaseScope\(\)\]\)/,
  );
});

test('each hook that the generator creates is executable', async () => {
  const tree = workspace();

  await initGenerator(tree);

  const modes = tree
    .listChanges()
    .filter((change) => change.path.startsWith('.husky/'))
    .map((change) => [change.path, change.options?.mode]);
  assert.deepEqual(modes.toSorted(), [
    ['.husky/commit-msg.ts', '755'],
    ['.husky/pre-commit.ts', '755'],
    ['.husky/pre-push.ts', '755'],
  ]);
});

test('the Nx family gets one exact version, also over a newer one', async () => {
  const tree = workspace();
  writeJson(tree, 'package.json', {
    name: '@acme/source',
    dependencies: { '@nx/node': '24.9.0' },
    devDependencies: { nx: '24.9.0', '@nx/js': '^24.0.0' },
  });

  await initGenerator(tree);

  const { dependencies, devDependencies } = readJson(tree, 'package.json');
  assert.equal(dependencies['@nx/node'], nxVersion);
  for (const name of [
    'nx',
    '@nx/devkit',
    '@nx/eslint',
    '@nx/eslint-plugin',
    '@nx/js',
  ]) {
    assert.equal(devDependencies[name], nxVersion, name);
  }
});

test('a root tool that is there keeps its version', async () => {
  const tree = workspace();
  writeJson(tree, 'package.json', {
    name: '@acme/source',
    devDependencies: {
      eslint: '10.1.0',
      '@zukhruf/nx': 'file:../zukhruf-nx.tgz',
    },
    allowScripts: { nx: true },
  });

  await initGenerator(tree);

  const { devDependencies, allowScripts } = readJson(tree, 'package.json');
  assert.equal(devDependencies['eslint'], '10.1.0');
  assert.equal(devDependencies['@zukhruf/nx'], 'file:../zukhruf-nx.tgz');
  assert.deepEqual(allowScripts, { nx: true, 'unrs-resolver': false });
});

test('a repo with only a backend gets no wiring of one kind of app', async () => {
  const tree = workspace();

  await initGenerator(tree);

  const { devDependencies } = readJson(tree, 'package.json');
  for (const name of Object.keys(devDependencies)) {
    assert.doesNotMatch(
      name,
      /react|vite|vitest|tailwind|esbuild|@nx\/node|testing-library|happy-dom/,
    );
  }
  const nxJson = readJson(tree, 'nx.json');
  assert.equal(nxJson.generators, undefined);
  assert.equal(nxJson.sync.generatorOptions, undefined);
  assert.equal(nxJson.targetDefaults['@nx/esbuild:esbuild'], undefined);
  assert.doesNotMatch(JSON.stringify(nxJson), /\^sdk|tailwind/);
  assert.deepEqual(readJson(tree, '.prettierrc').plugins, [
    '@trivago/prettier-plugin-sort-imports',
  ]);
  assert.doesNotMatch(
    tree.read('eslint.config.mjs', 'utf-8') ?? '',
    /configs\['(hono|react|react-router|tailwind)'\]/,
  );
});

test('a second run changes nothing', async () => {
  const tree = workspace();
  await initGenerator(tree);
  const firstRun = new Map(
    tree
      .listChanges()
      .map((change) => [change.path, change.content?.toString()]),
  );

  await initGenerator(tree);

  const secondRun = tree.listChanges();
  assert.equal(secondRun.length, firstRun.size);
  for (const change of secondRun) {
    assert.equal(
      change.content?.toString(),
      firstRun.get(change.path),
      change.path,
    );
  }
});

test('the scripts and allowScripts that are there keep their order', async () => {
  const tree = workspace();
  writeJson(tree, 'package.json', {
    name: '@acme/source',
    scripts: { build: 'nx run-many -t build', prepare: 'husky' },
    allowScripts: { esbuild: true, nx: false },
    devDependencies: {},
  });

  await initGenerator(tree);

  const packageJson = readJson(tree, 'package.json');
  assert.deepEqual(Object.entries(packageJson.scripts), [
    ['build', 'nx run-many -t build'],
    ['prepare', 'husky'],
  ]);
  assert.deepEqual(Object.entries(packageJson.allowScripts), [
    ['esbuild', true],
    ['nx', false],
    ['unrs-resolver', false],
  ]);
});

test('the target defaults and lines that are there stay', async () => {
  const tree = workspace();
  writeJson(tree, 'nx.json', {
    plugins: ['@nx/vite/plugin', '@nx/eslint/plugin'],
    namedInputs: { production: ['default', '!{projectRoot}/sdk-it.config.ts'] },
    targetDefaults: {
      build: { dependsOn: ['^build', '^sdk'] },
      typecheck: { dependsOn: ['^typecheck', 'lint', 'format:check', '^sdk'] },
      serve: { continuous: true, cache: false },
    },
  });
  tree.write('.gitignore', '/.scratch/\nnode_modules/');

  await initGenerator(tree);

  const nxJson = readJson(tree, 'nx.json');
  assert.deepEqual(nxJson.targetDefaults.build, {
    dependsOn: ['^build', '^sdk'],
  });
  assert.deepEqual(nxJson.targetDefaults.typecheck.dependsOn, [
    '^typecheck',
    'lint',
    'format:check',
    '^sdk',
    '...',
  ]);
  assert.deepEqual(nxJson.targetDefaults.serve, {
    continuous: false,
    cache: false,
  });
  assert.equal(nxJson.targetDefaults.lint, undefined);
  assert.deepEqual(nxJson.namedInputs.production.slice(0, 2), [
    'default',
    '!{projectRoot}/sdk-it.config.ts',
  ]);
  assert.deepEqual(
    nxJson.plugins.map((entry: string | { plugin: string }) =>
      typeof entry === 'string' ? entry : entry.plugin,
    ),
    [
      '@nx/js/typescript',
      '@nx/vite/plugin',
      '@nx/eslint/plugin',
      '@zukhruf/nx/lint',
      '@zukhruf/nx/format',
      '@zukhruf/nx/test',
    ],
  );
  const gitignore = tree.read('.gitignore', 'utf-8') ?? '';
  assert.ok(
    gitignore.startsWith('/.scratch/\nnode_modules/\n.nx/\n'),
    gitignore,
  );
  assert.equal(
    gitignore.split('\n').filter((line) => line === 'node_modules/').length,
    1,
  );
});

test('a prettier config that is there stays', async () => {
  const tree = workspace();
  writeJson(tree, '.prettierrc', { singleQuote: false });

  await initGenerator(tree);

  assert.deepEqual(readJson(tree, '.prettierrc'), { singleQuote: false });
});
