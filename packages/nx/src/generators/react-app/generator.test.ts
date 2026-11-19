import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson } from '@nx/devkit';

import {
  generatorTree,
  rootPackageNames,
} from '../../testing/generator-tree.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import { appPackageVersions, nxVersion } from '../versions.ts';
import reactAppGenerator from './generator.ts';

test('the entry point is a React Router 8 SPA in data mode', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  const main = tree.read('apps/web/src/main.tsx', 'utf-8') ?? '';
  assert.match(main, /import \{ createBrowserRouter \} from 'react-router';/);
  assert.match(main, /import \{ RouterProvider \} from 'react-router\/dom';/);
  assert.ok(!tree.exists('apps/web/react-router.config.ts'));
  assert.ok(!tree.exists('apps/web/src/app/nx-welcome.tsx'));
  assert.ok(!tree.exists('apps/web/src/app/app.module.css'));
  assert.match(
    tree.read('apps/web/src/app/app.tsx', 'utf-8') ?? '',
    /Welcome to web/,
  );
  const packageJson = readJson(tree, 'apps/web/package.json');
  assert.equal(packageJson.name, '@acme/web');
  assert.deepEqual(packageJson.dependencies, {
    react: appPackageVersions.react,
    'react-dom': appPackageVersions['react-dom'],
    'react-router': appPackageVersions['react-router'],
  });
  assert.equal(packageJson.sideEffects, false);
  assert.deepEqual(packageJson.scripts, {});
});

test('the Vite config, index.html and styles carry no brand', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  assert.ok(!tree.exists('apps/web/vite.config.mts'));
  const viteConfig = tree.read('apps/web/vite.config.ts', 'utf-8') ?? '';
  assert.match(viteConfig, /reactCompilerPreset\(\)/);
  assert.match(viteConfig, /tailwindcss\(\)/);
  assert.match(viteConfig, /compression\(/);
  assert.match(viteConfig, /PORTLESS_URL/);
  assert.match(
    viteConfig,
    /API_PROXY_TARGET \?\? 'http:\/\/127\.0\.0\.1:3000'/,
  );
  assert.match(
    viteConfig,
    /cacheDir: '\.\.\/\.\.\/node_modules\/\.vite\/apps\/web'/,
  );
  assert.match(
    viteConfig,
    /exclude: \[\/\\\/dist\\\/\/, \/\\\/node_modules\\\/\/\]/,
  );
  const indexHtml = tree.read('apps/web/index.html', 'utf-8') ?? '';
  assert.match(indexHtml, /<title>web<\/title>/);
  assert.doesNotMatch(indexHtml, /fonts\.googleapis|favicon|theme-color/);
  // The theme script of the standard sets the class before the first paint.
  assert.match(indexHtml, /localStorage\.getItem\('theme'\)/);
  assert.match(indexHtml, /prefers-color-scheme: dark/);
  assert.ok(
    indexHtml.indexOf('<script>') < indexHtml.indexOf('/src/styles.css'),
    'the theme script runs before the stylesheet loads',
  );
  assert.ok(!tree.exists('apps/web/public/favicon.ico'));
  const styles = tree.read('apps/web/src/styles.css', 'utf-8') ?? '';
  assert.match(styles, /@import ['"]tailwindcss['"];/);
  assert.match(styles, /nx-tailwind-sources:start/);
  assert.match(styles, /@custom-variant dark \(&:is\(\.dark, \.dark \*\)\);/);
  for (const path of ['apps/web/vite.config.ts', 'apps/web/index.html']) {
    assert.doesNotMatch(tree.read(path, 'utf-8') ?? '', /[Ff]actory|text2sql/);
  }
});

test('the portless domain comes from the workspace scope', async () => {
  const tree = generatorTree('@meddit/source');

  await reactAppGenerator(tree, { directory: 'apps/web' });

  assert.equal(
    readJson(tree, 'apps/web/package.json').nx.targets.portless.command,
    'portless --name web.meddit -- nx run @meddit/web:dev --output-style=stream-without-prefixes',
  );
});

test('the project config loads the React, React Router and Tailwind lint configs', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/team/web' });

  const eslintConfig =
    tree.read('apps/team/web/eslint.config.mjs', 'utf-8') ?? '';
  assert.match(eslintConfig, /^import react from '@zukhruf\/eslint\/react';$/m);
  assert.match(eslintConfig, /from '\.\.\/\.\.\/\.\.\/eslint\.config\.mjs'/);
  assert.match(eslintConfig, /\.\.\.zukhruf\.configs\['react-router'\]/);
  assert.match(eslintConfig, /\.\.\.zukhruf\.configs\['tailwind'\]/);
  assert.doesNotMatch(eslintConfig, /flat\/react/);
  const rootPackageJson = readJson(tree, 'package.json');
  for (const plugin of [
    '@eslint-react/eslint-plugin',
    'eslint-plugin-jsx-a11y-x',
    'eslint-plugin-react-hooks',
    'eslint-plugin-react-you-might-not-need-an-effect',
  ] as const) {
    assert.equal(
      rootPackageJson.devDependencies[plugin],
      appPackageVersions[plugin],
      plugin,
    );
  }
  for (const name of [
    'eslint-plugin-import',
    'eslint-plugin-jsx-a11y',
    'eslint-plugin-react',
    '@swc/core',
    '@vitest/ui',
    'react',
    'react-dom',
  ]) {
    assert.ok(!rootPackageNames(tree).includes(name), name);
  }
});

test('tsc --build of the app writes to out-tsc, not to the dist of Vite', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  const { compilerOptions } = readJson(tree, 'apps/web/tsconfig.app.json');
  assert.equal(compilerOptions.outDir, 'out-tsc');
  assert.equal(
    compilerOptions.tsBuildInfoFile,
    'out-tsc/tsconfig.app.tsbuildinfo',
  );
});

test('component tests run with Vitest once, in testMode run', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  const nxJson = readJson(tree, 'nx.json');
  const vitest = nxJson.plugins.find(
    (entry: string | { plugin: string }) =>
      typeof entry === 'object' && entry.plugin === '@nx/vitest',
  );
  assert.equal(vitest?.options.testMode, 'run');
  assert.deepEqual(readJson(tree, 'apps/web/package.json').nx.targets.test, {
    dependsOn: ['^sdk'],
    options: { env: { NODE_ENV: 'test' } },
  });
  const spec = readJson(tree, 'apps/web/tsconfig.spec.json');
  assert.ok(
    spec.compilerOptions.types.includes('@testing-library/jest-dom/vitest'),
  );
  assert.ok(!spec.compilerOptions.types.includes('vitest/globals'));
  assert.equal(spec.compilerOptions.jsx, 'react-jsx');
  const seed = tree.read('apps/web/src/app/app.test.tsx', 'utf-8') ?? '';
  assert.match(seed, /render\(<App \/>\)/);
  assert.match(seed, /finally \{\n\s+cleanup\(\);/);
  const { devDependencies } = readJson(tree, 'package.json');
  assert.equal(devDependencies.vitest, appPackageVersions.vitest);
  assert.equal(
    devDependencies['@vitest/coverage-v8'],
    appPackageVersions['@vitest/coverage-v8'],
  );
});

test('after node-app, test.dependsOn stays ["...", "^sdk"] with no ^build of @nx/vitest', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  await reactAppGenerator(tree, { directory: 'apps/web' });

  assert.deepEqual(readJson(tree, 'nx.json').targetDefaults.test, {
    dependsOn: ['...', '^sdk'],
  });
});

test('a web app alone starts the portless proxy unprivileged on HTTPS, with no TLD', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  assert.deepEqual(readJson(tree, 'nx.json').targetDefaults.portless, {
    options: { env: { PORTLESS_UNPRIVILEGED: '1', PORTLESS_HTTPS: '1' } },
  });
});

test('a web app alone gets no test target default', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  assert.equal(readJson(tree, 'nx.json').targetDefaults.test, undefined);
});

test('a web app alone denies the install script of the fsevents that vite brings', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  // strict-allow-scripts stops npm install on a package with no decision.
  assert.equal(readJson(tree, 'package.json').allowScripts?.fsevents, false);
});

test('Tailwind is wired in nx.json, .prettierrc and the root packages', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  const nxJson = readJson(tree, 'nx.json');
  const sync = '@juristr/nx-tailwind-sync:source-directives';
  assert.deepEqual(nxJson.sync.generatorOptions[sync], {
    additionalStylePaths: ['styles.css'],
  });
  for (const target of ['build', 'dev', 'serve']) {
    assert.ok(
      nxJson.targetDefaults[target].syncGenerators.includes(sync),
      target,
    );
  }
  assert.equal(nxJson.generators['@nx/react'].application.bundler, 'vite');
  assert.equal(
    nxJson.generators['@nx/react'].application.unitTestRunner,
    'none',
  );
  assert.deepEqual(readJson(tree, '.prettierrc').plugins, [
    '@trivago/prettier-plugin-sort-imports',
    'prettier-plugin-tailwindcss',
  ]);
  const rootPackageJson = readJson(tree, 'package.json');
  assert.equal(
    rootPackageJson.devDependencies.tailwindcss,
    appPackageVersions.tailwindcss,
  );
  assert.equal(rootPackageJson.devDependencies.vite, appPackageVersions.vite);
  assert.deepEqual(rootPackageJson.overrides['@juristr/nx-tailwind-sync'], {
    '@nx/devkit': nxVersion,
  });
  for (const name of rootPackageNames(tree)) {
    if (name === 'nx' || name.startsWith('@nx/')) {
      assert.equal(rootPackageJson.devDependencies[name], nxVersion, name);
    }
  }
});

test('the Vitest config gives each test the 300 s test limit of zukhruf', async () => {
  const tree = generatorTree();

  await reactAppGenerator(tree, { directory: 'apps/web' });

  const viteConfig = tree.read('apps/web/vite.config.ts', 'utf-8') ?? '';
  assert.match(viteConfig, /testTimeout: 300_000,/);
});
