import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { gitignore } from '../init/files.ts';
import { nxVersion } from '../versions.ts';
import presetGenerator from './generator.ts';

/** The files that `nx new` of create-nx-workspace 24.0.6 writes for a third-party preset. */
function nxNewFiles(): Tree {
  const tree = createTreeWithEmptyWorkspace({ formatter: 'none' });
  tree.delete('tsconfig.base.json');
  writeJson(tree, 'package.json', {
    name: '@acme/source',
    version: '0.0.0',
    license: 'MIT',
    scripts: {},
    private: true,
    dependencies: { '@zukhruf/nx': '0.8.29' },
    devDependencies: { nx: '24.1.0', '@nx/workspace': '24.1.0' },
    packageManager: 'npm@12.2.2',
  });
  writeJson(tree, 'nx.json', {
    $schema: './node_modules/nx/schemas/nx-schema.json',
    namedInputs: {
      default: ['{projectRoot}/**/*', 'sharedGlobals'],
      production: ['default'],
      sharedGlobals: [],
    },
  });
  tree.write('.gitignore', '# compiled output\ndist\ntmp\n.claude/worktrees\n');
  tree.write('.editorconfig', '[*.md]\nmax_line_length = off\n');
  writeJson(tree, '.vscode/extensions.json', {
    recommendations: ['nrwl.angular-console'],
  });
  tree.write('README.md', '# Acme\n\nNx Cloud onboarding.\n');
  // `nx g` writes these before it calls a generator named preset.
  tree.write('apps/.gitkeep', '');
  tree.write('libs/.gitkeep', '');
  return tree;
}

test('the preset turns the files of nx new into the root files of the standard', async () => {
  const tree = nxNewFiles();

  await presetGenerator(tree, { name: 'acme', packageManager: 'npm' });

  const packageJson = readJson(tree, 'package.json');
  assert.equal(packageJson.name, '@acme/source');
  assert.equal(packageJson.packageManager, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies['@zukhruf/nx'], '0.8.29');
  assert.equal(packageJson.devDependencies['@nx/workspace'], undefined);
  assert.equal(packageJson.devDependencies['nx'], nxVersion);
  for (const [name, version] of Object.entries(packageJson.devDependencies)) {
    if (name.startsWith('@nx/')) assert.equal(version, nxVersion, name);
  }
  assert.equal(tree.read('.gitignore', 'utf-8'), gitignore);
  assert.doesNotMatch(
    tree.read('.editorconfig', 'utf-8') ?? '',
    /max_line_length/,
  );
  assert.deepEqual(readJson(tree, '.vscode/extensions.json').recommendations, [
    'nrwl.angular-console',
    'esbenp.prettier-vscode',
    'dbaeumer.vscode-eslint',
  ]);
  assert.equal(
    tree.read('README.md', 'utf-8'),
    '# acme\n\nThe commands are in [AGENTS.md](./AGENTS.md).\n',
  );
  const nxJson = readJson(tree, 'nx.json');
  assert.deepEqual(nxJson.namedInputs.production.at(-1), { env: 'NODE_ENV' });
  assert.deepEqual(nxJson.namedInputs.sharedGlobals, [
    '{workspaceRoot}/eslint.config.mjs',
    '{workspaceRoot}/tsconfig.base.json',
  ]);
  assert.ok(tree.exists('.husky/pre-commit.ts'));
  assert.equal(tree.exists('apps/.gitkeep'), false);
  assert.equal(tree.exists('libs'), false);
});

test('the preset stops for a package manager other than npm', async () => {
  const tree = nxNewFiles();

  await assert.rejects(
    presetGenerator(tree, { name: 'acme', packageManager: 'pnpm' }),
    /npm workspaces only, not pnpm/,
  );
});
