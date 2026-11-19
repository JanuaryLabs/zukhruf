import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson, writeJson } from '@nx/devkit';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import { lintManifests } from '../../testing/lint-manifests.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import reactAppGenerator from '../react-app/generator.ts';
import { appPackageVersions } from '../versions.ts';
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
  assert.match(
    tree.read('apps/backend/src/app.ts', 'utf-8') ?? '',
    /\(await import\('\.\/routes\/ui\.route\.ts'\)\)\.default\(app\);/,
  );
  const uiRoute =
    tree.read('apps/backend/src/routes/ui.route.ts', 'utf-8') ?? '';
  assert.match(uiRoute, /relative\(process\.cwd\(\), import\.meta\.dirname\)/);
  assert.match(uiRoute, /'\.\.\/\.\.\/web\/dist'/);
  assert.match(uiRoute, /precompressed: true/);
  assert.match(uiRoute, /\(expected \$\{indexHtml\}\)/);
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
  assert.match(uiRoute, /A GET under \/api\/ goes on to the API\n\/\/ routes/);
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
  assert.match(dockerfile, /PORT=8080 BUILD_SHA=\$BUILD_SHA$/m);
});

test('what pair writes lints clean under @zukhruf/eslint', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });

  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });

  assert.deepEqual(await lintManifests(tree), []);
});
