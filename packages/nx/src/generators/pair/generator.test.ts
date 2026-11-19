import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson, writeJson } from '@nx/devkit';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import { lintManifests } from '../../testing/lint-manifests.ts';
import { lintNodeEnv } from '../../testing/lint-node-env.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import reactAppGenerator from '../react-app/generator.ts';
import { appPackageVersions } from '../versions.ts';
import { legacyUiMount } from './files.ts';
import pairGenerator from './generator.ts';

test('the web gets the client of the api, and the api serves the web build', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const web = readJson(tree, 'apps/web/package.json');
  assert.equal(web.dependencies['@acme/backend-client'], '*');
  assert.equal(web.dependencies.zod, appPackageVersions.zod);
  assert.equal(
    web.dependencies['fast-content-type-parse'],
    appPackageVersions['fast-content-type-parse'],
  );
  assert.equal(web.nx.implicitDependencies, undefined);
  const api = tree.read('apps/web/src/api.ts', 'utf-8') ?? '';
  assert.match(api, /from '@acme\/backend-client'/);
  assert.match(api, /new URL\('\/api', globalThis\.location\.origin\)/);
  const uiRoute =
    tree.read('apps/backend/src/routes/ui.route.ts', 'utf-8') ?? '';
  assert.match(uiRoute, /serveStatic\(\{\n\s+root,\n\s+precompressed: true,/);
  const dockerfile = tree.read('apps/backend/Dockerfile', 'utf-8') ?? '';
  assert.match(dockerfile, /--projects @acme\/backend,@acme\/web \\\n/);
  assert.match(
    dockerfile,
    /^COPY --from=build \/workspace\/apps\/web\/dist \.\/apps\/web\/dist$/m,
  );
  assert.match(dockerfile, /^ARG BUILD_SHA$/m);
});

test('the SPA route comment is whole and names no other repo', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const uiRoute =
    tree.read('apps/backend/src/routes/ui.route.ts', 'utf-8') ?? '';
  assert.doesNotMatch(uiRoute, /text2sql|[Ff]actory/);
  assert.doesNotMatch(uiRoute, / and\n\/\/ *\n|routes and\nexport/);
  assert.match(
    uiRoute,
    /A GET under \/api\/ goes on to the API routes and their notFound\.\n/,
  );
});

test('a second run changes nothing', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  const firstRun = changes(tree);

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  assert.deepEqual(changes(tree), firstRun);
});

test('an api that is not a node-app stops the generator', async () => {
  const tree = generatorTree();
  await reactAppGenerator(tree, { directory: 'apps/web' });
  writeJson(tree, 'apps/backend/package.json', { name: '@acme/backend' });

  await assert.rejects(
    pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' }),
    /apps\/backend has no sdk-it\.config\.ts, so it is not a node-app\. Run @zukhruf\/nx:node-app apps\/backend first\./,
  );
});

test('the port of the api goes into the image', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend', port: 8080 });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const dockerfile = tree.read('apps/backend/Dockerfile', 'utf-8') ?? '';
  assert.match(dockerfile, /^EXPOSE 8080$/m);
  assert.match(dockerfile, /PORT=8080 BUILD_SHA=\$BUILD_SHA /m);
});

test('what pair writes lints clean under @zukhruf/eslint', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  assert.deepEqual(await lintManifests(tree), []);
});

test('app.ts mounts the UI route only when UI_ROOT is set, and env.ts declares it optional', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const app = tree.read('apps/backend/src/app.ts', 'utf-8') ?? '';
  assert.match(
    app,
    /^const uiRoot = process\.env\.UI_ROOT;\nif \(uiRoot !== undefined\) \{\n {2}await \(await import\('\.\/routes\/ui\.route\.ts'\)\)\.default\(app, uiRoot\);\n\}\n\napp\.notFound/m,
  );
  assert.equal(app.split("import('./routes/ui.route.ts')").length, 2);
  assert.match(
    tree.read('apps/backend/src/env.ts', 'utf-8') ?? '',
    /^ {2}UI_ROOT: z\.string\(\)\.min\(1\)\.optional\(\),$/m,
  );
});

test('the UI route reads index.html of UI_ROOT at startup, and the process exits naming the path when it is missing', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const uiRoute =
    tree.read('apps/backend/src/routes/ui.route.ts', 'utf-8') ?? '';
  assert.match(
    uiRoute,
    /export default async function \(router: Hono, root: string\): Promise<void> \{\n\s+const indexHtml = join\(root, 'index\.html'\);\n\s+const html = await readIndexHtml\(indexHtml\);/,
  );
  assert.match(uiRoute, /return c\.html\(html\);/);
  assert.match(
    uiRoute,
    /error\.code === 'ENOENT'\)\)\s+\{\n\s+throw error;\n\s+\}\n\s+logError\(\n\s+\{\n\s+event: 'ui\.build\.missing',\n\s+message: `UI_ROOT names no web build: \$\{path\} does not exist\. Build the web app, or unset UI_ROOT\.`,\n\s+\},\n\s+error,\n\s+\);\n\s+process\.exit\(1\);/,
  );
  assert.doesNotMatch(uiRoute, /process\.env/);
});

test('the image sets UI_ROOT to the folder it copies the web build into', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const dockerfile = tree.read('apps/backend/Dockerfile', 'utf-8') ?? '';
  assert.match(
    dockerfile,
    /^ENV NODE_ENV=production HOST=0\.0\.0\.0 PORT=3000 BUILD_SHA=\$BUILD_SHA UI_ROOT=\/app\/apps\/web\/dist$/m,
  );
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(
    dockerfile,
    /^COPY --from=build \/workspace\/apps\/web\/dist \.\/apps\/web\/dist$/m,
  );
});

test('a mount that pair wrote before UI_ROOT is replaced, not doubled', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  tree.write(
    'apps/backend/src/app.ts',
    (tree.read('apps/backend/src/app.ts', 'utf-8') ?? '').replace(
      '\napp.notFound((c) =>',
      `\n${legacyUiMount}\n\napp.notFound((c) =>`,
    ),
  );

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  const app = tree.read('apps/backend/src/app.ts', 'utf-8') ?? '';
  assert.doesNotMatch(app, /pair fixed the path/);
  assert.equal(app.split("import('./routes/ui.route.ts')").length, 2);
  assert.match(app, /\.default\(app, uiRoot\);/);
});

test('the code that pair writes reads no NODE_ENV', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  assert.deepEqual(await lintNodeEnv(tree), []);
});
