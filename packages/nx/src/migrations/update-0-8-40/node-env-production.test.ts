import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, logger, readJson, updateJson } from '@nx/devkit';

import dokployGenerator from '../../generators/dokploy/generator.ts';
import nodeAppGenerator from '../../generators/node-app/generator.ts';
import prismaGenerator from '../../generators/prisma/generator.ts';
import reactAppGenerator from '../../generators/react-app/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import nodeEnvProduction from './node-env-production.ts';

interface Target {
  options?: { env?: Record<string, string> };
}
interface Manifest {
  nx: { targets: Record<string, Target> };
}
interface NxJson {
  targetDefaults: Record<string, Target>;
}

/** A backend, its db package, a web and the dokploy delivery, as the generators write them now. */
async function workspace(): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await dokployGenerator(tree, { api: 'apps/backend', owner: 'acme' });
  return tree;
}

const withoutNodeEnv = (target: Target | undefined) => {
  if (target?.options?.env === undefined) return;
  delete target.options.env['NODE_ENV'];
};

/** The same workspace as the generators wrote it before ADR 0016. */
async function oldWorkspace(): Promise<Tree> {
  const tree = await workspace();
  updateJson(tree, 'nx.json', (nxJson: NxJson) => {
    withoutNodeEnv(nxJson.targetDefaults['test']);
    withoutNodeEnv(nxJson.targetDefaults['serve']);
    return nxJson;
  });
  updateJson(tree, 'apps/backend/package.json', (manifest: Manifest) => {
    const env = manifest.nx.targets['serve']?.options?.env;
    if (env !== undefined) env['NODE_ENV'] = 'development';
    return manifest;
  });
  updateJson(
    tree,
    'apps/backend/.sdk-it/package.json',
    (manifest: Manifest) => {
      withoutNodeEnv(manifest.nx.targets['sdk']);
      return manifest;
    },
  );
  updateJson(tree, 'packages/db/package.json', (manifest: Manifest) => {
    withoutNodeEnv(manifest.nx.targets['up']);
    return manifest;
  });
  updateJson(tree, 'apps/web/package.json', (manifest: Manifest) => {
    delete manifest.nx.targets['dev'];
    delete manifest.nx.targets['serve'];
    return manifest;
  });
  for (const path of [
    'apps/backend/.env.example',
    'apps/backend/.env',
    'packages/db/.env.example',
    'packages/db/.env',
    'infra/.env.example',
  ]) {
    const content = tree.read(path, 'utf-8') ?? '';
    tree.write(
      path,
      content.replace(/^# .*NODE_ENV.*\n/m, '').replace(/^NODE_ENV=.*\n/m, ''),
    );
  }
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy.yml',
  ]) {
    const content = tree.read(path, 'utf-8') ?? '';
    tree.write(
      path,
      content
        .replace(/^# Every setup runs under production.*\n/m, '')
        .replace(/^ {2}# Every setup runs under production.*\n/m, '')
        .replace(/^ {2}NODE_ENV: production\n/m, '')
        .replace(/^ {2}# npm omits devDependencies.*\n/m, '')
        .replace(/^ {2}npm_config_include: dev\n/m, '')
        .replace(/^env:\n\n/m, ''),
    );
  }
  const mainTf = 'infra/src/environments/production/main.tf';
  tree.write(
    mainTf,
    (tree.read(mainTf, 'utf-8') ?? '')
      .replace(/^# ALLOWED_ORIGINS is the public origin.*\n/m, '')
      .replace(/^ +ALLOWED_ORIGINS = .*\n/m, ''),
  );
  return tree;
}

const env = (tree: Tree, path: string, target: string) =>
  readJson<Manifest>(tree, path).nx.targets[target]?.options?.env?.['NODE_ENV'];

test('a repo of the old shape gets the NODE_ENV configuration that the generators write now', async () => {
  const tree = await oldWorkspace();

  await nodeEnvProduction(tree);

  const { targetDefaults } = readJson<NxJson>(tree, 'nx.json');
  assert.equal(
    targetDefaults['test']?.options?.env?.['NODE_ENV'],
    'production',
  );
  assert.equal(
    targetDefaults['serve']?.options?.env?.['NODE_ENV'],
    'production',
  );
  assert.equal(env(tree, 'apps/backend/package.json', 'serve'), 'production');
  assert.equal(
    env(tree, 'apps/backend/.sdk-it/package.json', 'sdk'),
    'production',
  );
  assert.equal(env(tree, 'packages/db/package.json', 'up'), 'production');
  assert.equal(env(tree, 'apps/web/package.json', 'dev'), 'development');
  assert.equal(env(tree, 'apps/web/package.json', 'serve'), 'development');
  assert.equal(env(tree, 'apps/web/package.json', 'test'), 'test');
  for (const path of [
    'apps/backend/.env.example',
    'apps/backend/.env',
    'packages/db/.env.example',
    'infra/.env.example',
  ]) {
    assert.match(
      tree.read(path, 'utf-8') ?? '',
      /^NODE_ENV=production$/m,
      path,
    );
  }
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/deploy.yml',
  ]) {
    const workflow = tree.read(path, 'utf-8') ?? '';
    assert.match(
      workflow,
      /^env:\n(?: {2}.*\n)*? {2}NODE_ENV: production\n/m,
      path,
    );
    assert.match(
      workflow,
      /^env:\n(?: {2}.*\n)*? {2}npm_config_include: dev\n/m,
      path,
    );
  }
  assert.match(
    tree.read('infra/src/environments/production/main.tf', 'utf-8') ?? '',
    /^ +ALLOWED_ORIGINS = "https:\/\/\$\{local\.host\}"$/m,
  );
});

test('a backend serve with a NODE_ENV of its own other than the old development keeps it', async () => {
  const tree = await oldWorkspace();
  updateJson(tree, 'apps/backend/package.json', (manifest: Manifest) => {
    const target = manifest.nx.targets['serve'];
    if (target?.options?.env !== undefined)
      target.options.env['NODE_ENV'] = 'staging';
    return manifest;
  });

  await nodeEnvProduction(tree);

  assert.equal(env(tree, 'apps/backend/package.json', 'serve'), 'staging');
});

test('each NODE_ENV read in source is logged with its file and line, and a write is not', async (t) => {
  const tree = await oldWorkspace();
  tree.write(
    'apps/backend/src/flags.ts',
    "export const debug = process.env.NODE_ENV !== 'production';\nprocess.env.NODE_ENV = 'production';\n",
  );
  const warn = t.mock.method(logger, 'warn', () => {});

  await nodeEnvProduction(tree);

  const logged = warn.mock.calls
    .map((call) => String(call.arguments[0]))
    .join('\n');
  assert.match(logged, /^apps\/backend\/src\/flags\.ts:1$/m);
  assert.doesNotMatch(logged, /^apps\/backend\/src\/flags\.ts:2$/m);
  assert.equal(
    tree.read('apps/backend/src/flags.ts', 'utf-8'),
    "export const debug = process.env.NODE_ENV !== 'production';\nprocess.env.NODE_ENV = 'production';\n",
  );
});

test('a second run writes nothing', async () => {
  const tree = await oldWorkspace();
  await nodeEnvProduction(tree);
  const first = new Map(changes(tree));

  await nodeEnvProduction(tree);

  assert.deepEqual(new Map(changes(tree)), first);
});

test('a repo the generators already wrote under ADR 0016 gets no change', async () => {
  const tree = await workspace();
  const before = new Map(changes(tree));

  await nodeEnvProduction(tree);

  assert.deepEqual(new Map(changes(tree)), before);
});

test('a repo with no backend, db package or web gets no change', async () => {
  const tree = generatorTree();
  const before = [...changes(tree).entries()];

  await nodeEnvProduction(tree);

  assert.deepEqual([...changes(tree).entries()], before);
});
