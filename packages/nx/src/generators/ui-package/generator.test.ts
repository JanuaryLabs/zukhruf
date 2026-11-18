import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson } from '@nx/devkit';

import {
  changes,
  generatorTree,
  rootPackageNames,
} from '../../testing/generator-tree.ts';
import { appPackageVersions } from '../versions.ts';
import uiPackageGenerator from './generator.ts';

const options = { directory: 'packages/ui', importPath: '@acme/ui' };

test('a buildable React package with a development export of its source', async () => {
  const tree = generatorTree();

  await uiPackageGenerator(tree, options);

  const manifest = readJson(tree, 'packages/ui/package.json');
  assert.equal(manifest.name, '@acme/ui');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.exports['.'], {
    development: './src/index.ts',
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  });
  assert.deepEqual(manifest.dependencies, { react: appPackageVersions.react });
  assert.equal(
    manifest.devDependencies['vite-plugin-dts'],
    appPackageVersions['vite-plugin-dts'],
  );
  assert.deepEqual(manifest.nx.targets.test.dependsOn, ['...', 'build']);
  const viteConfig = tree.read('packages/ui/vite.config.ts', 'utf-8') ?? '';
  assert.match(viteConfig, /dts\(/);
  assert.match(viteConfig, /name: '@acme\/ui'/);
  assert.match(viteConfig, /id\.startsWith\('\\0'\)/);
  const eslintConfig =
    tree.read('packages/ui/eslint.config.mjs', 'utf-8') ?? '';
  assert.match(eslintConfig, /^import react from '@zukhruf\/eslint\/react';$/m);
  assert.match(eslintConfig, /\.\.\.zukhruf\.configs\['tailwind'\]/);
  assert.equal(
    tree.read('packages/ui/src/index.ts', 'utf-8'),
    "export { PackageName, packageName } from './package-name.tsx';\n",
  );
  assert.match(
    tree.read('packages/ui/src/package-name.tsx', 'utf-8') ?? '',
    /export function PackageName\(\)/,
  );
  assert.match(
    tree.read('packages/ui/tests/public-api.test.mjs', 'utf-8') ?? '',
    /from '@acme\/ui'/,
  );
  const componentTest =
    tree.read('packages/ui/tests/package-name.test.mjs', 'utf-8') ?? '';
  assert.match(componentTest, /GlobalRegistrator\.register\(\);\n {2}try \{/);
  assert.match(componentTest, /await import\('react-dom\/client'\)/);
  assert.match(componentTest, /await import\('@acme\/ui'\)/);
  assert.match(componentTest, /await GlobalRegistrator\.unregister\(\);/);
  for (const name of ['@happy-dom/global-registrator', 'react-dom'] as const) {
    assert.equal(
      manifest.devDependencies[name],
      appPackageVersions[name],
      name,
    );
  }
  assert.ok(!tree.exists('packages/ui/.babelrc'));
  assert.ok(!tree.exists('packages/ui/README.md'));
  for (const residue of [
    '@babel/core',
    '@babel/preset-react',
    '@swc/core',
    'ajv',
    'vite-plugin-dts',
    'eslint-plugin-react',
  ]) {
    assert.ok(!rootPackageNames(tree).includes(residue), residue);
  }
  assert.equal(
    readJson(tree, 'package.json').devDependencies['eslint-plugin-react-hooks'],
    appPackageVersions['eslint-plugin-react-hooks'],
  );
  assert.equal(readJson(tree, 'package.json').allowScripts.fsevents, false);
});

test('a second run keeps the files of the package', async () => {
  const tree = generatorTree();
  await uiPackageGenerator(tree, options);
  tree.write('packages/ui/src/index.ts', 'export const kept = true;\n');
  const firstRun = changes(tree);

  await uiPackageGenerator(tree, options);

  assert.deepEqual(changes(tree), firstRun);
});

test('a folder outside packages/ stops the generator', async () => {
  await assert.rejects(
    uiPackageGenerator(generatorTree(), {
      ...options,
      directory: 'packages/../outside',
    }),
    /goes under packages\//,
  );
});
