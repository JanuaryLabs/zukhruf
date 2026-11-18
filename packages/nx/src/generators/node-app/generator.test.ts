import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson, writeJson } from '@nx/devkit';

import {
  generatorTree,
  rootPackageNames,
} from '../../testing/generator-tree.ts';
import { appPackageVersions, nxVersion } from '../versions.ts';
import { clientManifest, clientTsconfig } from './files.ts';
import nodeAppGenerator, { createRequireBanner } from './generator.ts';

test('writes the Hono boot files and removes the scaffolding of @nx/node', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const server = tree.read('apps/backend/src/server.ts', 'utf-8') ?? '';
  assert.match(
    server,
    /^#!\/usr\/bin\/env tsx\n\/\/ @nx-target-name: serve\nimport '\.\/startup\.ts';/,
  );
  assert.match(server, /createTerminus\(/);
  assert.match(server, /await flushLogs\(\)/);
  assert.match(
    tree.read('apps/backend/src/startup.ts', 'utf-8') ?? '',
    /^import '\.\/env\.ts';/,
  );
  const app = tree.read('apps/backend/src/app.ts', 'utf-8') ?? '';
  assert.match(app, /app\.basePath\('\/api'\)/);
  assert.match(app, /import\('\.\/routes\/healthz\.route\.ts'\)/);
  assert.doesNotMatch(app, /ui\.route\.ts/);
  const logging = tree.read('apps/backend/src/logging.ts', 'utf-8') ?? '';
  assert.match(logging, /dir: '\.evlog\/logs\/backend'/);
  assert.match(logging, /service: 'backend'/);
  assert.ok(!tree.exists('apps/backend/src/main.ts'), 'main.ts of @nx/node');
  assert.ok(!tree.exists('apps/backend/src/assets/.gitkeep'));
  assert.ok(!tree.exists('.vscode/launch.json'), 'launch.json of @nx/node');
});

test('the health route reports the commit of the image from BUILD_SHA', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  assert.match(
    tree.read('apps/backend/src/env.ts', 'utf-8') ?? '',
    /BUILD_SHA: z\.string\(\)\.min\(1\)\.optional\(\),/,
  );
  assert.match(
    tree.read('apps/backend/src/routes/healthz.route.ts', 'utf-8') ?? '',
    /c\.json\(\{ status: 'ok', sha: process\.env\.BUILD_SHA \?\? null \}\)/,
  );
  assert.match(
    tree.read('apps/backend/src/app.test.ts', 'utf-8') ?? '',
    /\{ status: 'ok', sha: null \}/,
  );
  const dockerfile = tree.read('apps/backend/Dockerfile', 'utf-8') ?? '';
  const runtime = dockerfile.slice(
    dockerfile.indexOf('FROM node:lts-alpine AS runtime'),
  );
  assert.match(runtime, /^ARG BUILD_SHA$/m);
  assert.match(
    runtime,
    /^ENV NODE_ENV=production HOST=0\.0\.0\.0 PORT=3000 BUILD_SHA=\$BUILD_SHA$/m,
  );
  assert.equal(
    readJson(tree, 'apps/backend/package.json').nx.targets['docker:build']
      .command,
    'docker build --file apps/backend/Dockerfile --build-arg BUILD_SHA=$(git rev-parse HEAD) --tag acme-backend .',
  );
});

test('a VS Code launch configuration that is there stays', async () => {
  const tree = generatorTree();
  const launchJson = '{ "configurations": [] }\n';
  tree.write('.vscode/launch.json', launchJson);

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  assert.equal(tree.read('.vscode/launch.json', 'utf-8'), launchJson);
});

test('the build is one ESM esbuild bundle with each npm package external', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const { targets } = readJson(tree, 'apps/backend/package.json').nx;
  assert.equal(targets.build.executor, '@nx/esbuild:esbuild');
  assert.deepEqual(targets.build.options, {
    platform: 'node',
    target: 'esnext',
    bundle: true,
    format: ['esm'],
    main: 'apps/backend/src/server.ts',
    tsConfig: 'apps/backend/tsconfig.app.json',
    outputPath: 'apps/backend/dist',
    assets: [],
    declaration: false,
    sourcemap: true,
    esbuildOptions: { banner: { js: createRequireBanner } },
  });
  assert.equal(targets.build.configurations.development.skipTypeCheck, true);
  assert.deepEqual(targets.serve, {
    dependsOn: ['^build'],
    options: { env: { NODE_ENV: 'development' } },
  });
  assert.ok(targets['prune-lockfile'], 'prune-lockfile stays');
  assert.equal(targets['copy-workspace-modules'], undefined);
  assert.equal(targets.prune, undefined);
  // The format, lint and test areas infer these.
  assert.equal(targets.format, undefined);
  assert.equal(targets.test, undefined);
  assert.ok(!tree.exists('apps/backend/project.json'));
});

test('the tsconfigs keep type-check output out of dist', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const app = readJson(tree, 'apps/backend/tsconfig.app.json');
  assert.deepEqual(app.compilerOptions, {
    outDir: 'out-tsc',
    rootDir: 'src',
    tsBuildInfoFile: 'out-tsc/tsconfig.app.tsbuildinfo',
    types: ['node'],
  });
  assert.deepEqual(app.exclude, ['src/**/*.test.ts']);
  assert.deepEqual(readJson(tree, 'apps/backend/tsconfig.test.json').include, [
    'src/**/*.test.ts',
  ]);
  assert.deepEqual(readJson(tree, 'apps/backend/tsconfig.json').references, [
    { path: './tsconfig.app.json' },
    { path: './tsconfig.test.json' },
  ]);
});

test('the manifest and the portless domain come from the app and the workspace scope', async () => {
  const tree = generatorTree('@meddit/source');

  await nodeAppGenerator(tree, { directory: 'apps/backend', port: 8080 });

  const packageJson = readJson(tree, 'apps/backend/package.json');
  assert.equal(packageJson.name, '@meddit/backend');
  assert.equal(packageJson.type, 'module');
  // @zukhruf/eslint reads it to tell a bundled app from a library.
  assert.equal(packageJson.nx.projectType, 'application');
  assert.deepEqual(packageJson.dependencies, {
    '@godaddy/terminus': appPackageVersions['@godaddy/terminus'],
    '@hono/node-server': appPackageVersions['@hono/node-server'],
    '@sdk-it/hono': appPackageVersions['@sdk-it/hono'],
    evlog: appPackageVersions.evlog,
    hono: appPackageVersions.hono,
    zod: appPackageVersions.zod,
  });
  assert.equal(
    packageJson.nx.targets.portless.command,
    'portless --name backend.meddit --app-port 8080 -- nx run @meddit/backend:serve --output-style=stream-without-prefixes',
  );
  assert.match(
    tree.read('apps/backend/.env.example', 'utf-8') ?? '',
    /^PORT=8080$/m,
  );
  assert.match(
    tree.read('apps/backend/src/env.ts', 'utf-8') ?? '',
    /default\('8080'\)/,
  );
  assert.match(
    tree.read('apps/backend/Dockerfile', 'utf-8') ?? '',
    /^EXPOSE 8080$/m,
  );
});

test('a root package name with no scope stops the generator', async () => {
  const tree = generatorTree('acme');

  await assert.rejects(
    nodeAppGenerator(tree, { directory: 'apps/backend' }),
    /"acme" has no scope/,
  );
});

test('the root gets the build tools at their versions, one Nx version and no swc', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const { devDependencies, allowScripts } = readJson(tree, 'package.json');
  assert.equal(devDependencies.esbuild, appPackageVersions.esbuild);
  assert.equal(
    devDependencies['@sdk-it/cli'],
    appPackageVersions['@sdk-it/cli'],
  );
  assert.equal(allowScripts.esbuild, true);
  for (const name of rootPackageNames(tree)) {
    if (name === 'nx' || name.startsWith('@nx/')) {
      assert.equal(devDependencies[name], nxVersion, name);
    }
    assert.doesNotMatch(name, /^@swc\//);
  }
  assert.equal(devDependencies['@nx/node'], nxVersion);
});

test('a root package that was there keeps its version', async () => {
  const tree = generatorTree();
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/source',
      devDependencies: { esbuild: '0.27.0' },
      allowScripts: { esbuild: false },
    }),
  );

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const { devDependencies, allowScripts } = readJson(tree, 'package.json');
  assert.equal(devDependencies.esbuild, '0.27.0');
  assert.equal(allowScripts.esbuild, false);
});

test('a repo with only a backend installs no React, Vite, Vitest or Tailwind', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  for (const name of rootPackageNames(tree)) {
    assert.doesNotMatch(
      name,
      /react|vite|vitest|tailwind|testing-library|happy-dom|@juristr/,
    );
  }
  const nxJson = readJson(tree, 'nx.json');
  assert.doesNotMatch(JSON.stringify(nxJson), /tailwind|@nx\/react|vitest/);
  assert.deepEqual(readJson(tree, '.prettierrc').plugins, [
    '@trivago/prettier-plugin-sort-imports',
  ]);
});

test('the .env.example is the generator’s, and a .env that is there stays', async () => {
  const tree = generatorTree();
  tree.write('apps/backend/.env', 'PORT=1\n');

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const example = tree.read('apps/backend/.env.example', 'utf-8') ?? '';
  assert.match(example, /^PORT=3000$/m);
  assert.match(example, /^HOST=127\.0\.0\.1$/m);
  assert.match(example, /^ALLOWED_ORIGINS=$/m);
  assert.doesNotMatch(example, /NODE_ENV=/);
  assert.equal(tree.read('apps/backend/.env', 'utf-8'), 'PORT=1\n');
});

test('a missing .env starts as the example', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  assert.equal(
    tree.read('apps/backend/.env', 'utf-8'),
    tree.read('apps/backend/.env.example', 'utf-8'),
  );
});

test('a nested directory gets its paths right', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/team/backend' });

  const eslintConfig =
    tree.read('apps/team/backend/eslint.config.mjs', 'utf-8') ?? '';
  assert.match(eslintConfig, /from '\.\.\/\.\.\/\.\.\/eslint\.config\.mjs'/);
  assert.match(eslintConfig, /\.\.\.zukhruf\.configs\['hono'\]/);
  assert.match(eslintConfig, /\.\.\.modernNodeRecommended/);
  assert.match(eslintConfig, /startupFile: 'src\/env\.ts'/);
  assert.match(
    eslintConfig,
    /allowDefaultProject: \['apps\/team\/backend\/sdk-it\.config\.ts'\]/,
  );
  assert.equal(
    readJson(tree, 'apps/team/backend/tsconfig.app.json').extends,
    '../../../tsconfig.base.json',
  );
  assert.equal(
    readJson(tree, 'apps/team/backend/package.json').nx.targets.build.options
      .main,
    'apps/team/backend/src/server.ts',
  );
});

test('each app gets an sdk-it client package with a committed stub', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const config = tree.read('apps/backend/sdk-it.config.ts', 'utf-8') ?? '';
  assert.match(config, /tsconfig: '\.\/tsconfig\.app\.json'/);
  assert.match(config, /packageName: '@acme\/backend-client'/);
  assert.equal(
    tree.read('apps/backend/.sdk-it/package.json', 'utf-8'),
    clientManifest('@acme/backend-client', '@acme/backend'),
  );
  assert.equal(
    tree.read('apps/backend/.sdk-it/tsconfig.json', 'utf-8'),
    clientTsconfig('../../'),
  );
  assert.ok(
    readJson(tree, 'package.json').workspaces.includes('apps/backend/.sdk-it'),
  );
  const gitignore = tree.read('.gitignore', 'utf-8') ?? '';
  assert.match(gitignore, /^\*\*\/\.sdk-it\/\*$/m);
  assert.match(gitignore, /^!\*\*\/\.sdk-it\/package\.json$/m);
  assert.match(tree.read('.prettierignore', 'utf-8') ?? '', /^\.sdk-it$/m);
});

test('a client stub that was edited by hand stays', async () => {
  const tree = generatorTree();
  const stub = '{\n  "name": "custom"\n}\n';
  tree.write('apps/backend/.sdk-it/package.json', stub);

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  assert.equal(tree.read('apps/backend/.sdk-it/package.json', 'utf-8'), stub);
});

test('a second app adds no line and no workspace twice', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await nodeAppGenerator(tree, { directory: 'apps/billing' });

  const gitignore = tree.read('.gitignore', 'utf-8') ?? '';
  assert.equal(
    gitignore.split('\n').filter((line) => line === '**/.sdk-it/*').length,
    1,
  );
  const { workspaces } = readJson(tree, 'package.json');
  assert.equal(
    workspaces.filter((entry: string) => entry === 'apps/backend/.sdk-it')
      .length,
    1,
  );
  assert.ok(workspaces.includes('apps/billing/.sdk-it'));
});

test('the Dockerfile builds on the LTS image with the latest npm', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const dockerfile = tree.read('apps/backend/Dockerfile', 'utf-8') ?? '';
  assert.match(dockerfile, /^# @zukhruf\/nx:node-app writes this file/m);
  assert.match(dockerfile, /^FROM node:lts-alpine AS build$/m);
  assert.equal(dockerfile.split('RUN npm install -g npm@latest\n').length, 3);
  assert.match(dockerfile, /--projects @acme\/backend \\\n/);
  assert.match(dockerfile, /npx nx run @acme\/backend:prune-lockfile/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(
    dockerfile,
    /CMD \["node", "--enable-source-maps", "apps\/backend\/dist\/server\.js"\]/,
  );
  assert.ok(tree.exists('.dockerignore'));
  assert.deepEqual(
    readJson(tree, 'apps/backend/package.json').nx.targets['docker:run'],
    { command: 'docker run --rm --publish 3000:3000 acme-backend' },
  );
});

test('a .dockerignore that is there stays', async () => {
  const tree = generatorTree();
  tree.write('.dockerignore', 'custom\n');

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  assert.equal(tree.read('.dockerignore', 'utf-8'), 'custom\n');
});

test('nx.json gets the esbuild default, ^sdk, and test.dependsOn ["...", "^sdk"]', async () => {
  const tree = generatorTree();

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const { targetDefaults, namedInputs, generators } = readJson(tree, 'nx.json');
  assert.deepEqual(targetDefaults.test, { dependsOn: ['...', '^sdk'] });
  assert.ok(targetDefaults.build.dependsOn.includes('^sdk'));
  assert.ok(targetDefaults.dev.dependsOn.includes('^sdk'));
  assert.ok(targetDefaults.typecheck.dependsOn.includes('^sdk'));
  assert.equal(targetDefaults['@nx/esbuild:esbuild'].cache, true);
  assert.ok(targetDefaults['@nx/esbuild:esbuild'].dependsOn.includes('^build'));
  assert.ok(
    namedInputs.production.includes(
      '!{projectRoot}/sdk-it.config.{js,ts,mjs,mts}',
    ),
  );
  assert.equal(generators['@nx/node'].application.bundler, 'esbuild');
  assert.equal(generators['@nx/node'].application.unitTestRunner, 'none');
});

test('a generator default that is there keeps its value and its place', async () => {
  const tree = generatorTree();
  writeJson(tree, 'nx.json', {
    generators: {
      '@nx/node': { application: { docker: true, linter: 'none' } },
    },
  });

  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  const options = Object.entries(
    readJson(tree, 'nx.json').generators['@nx/node'].application,
  );
  assert.deepEqual(options.slice(0, 2), [
    ['docker', true],
    ['linter', 'none'],
  ]);
});
