import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, logger, readJson, updateJson } from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import reactAppGenerator from '../../generators/react-app/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import moveZukhrufPinsInProjectManifests from './move-zukhruf-pins-in-project-manifests.ts';

const rootPath = 'package.json';
const webPath = 'apps/web/package.json';
const backendPath = 'apps/backend/package.json';
const target = '0.8.117';

interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * A web and a backend as today's generators write them, with the @zukhruf
 * pins Meddit had after `nx migrate @zukhruf/nx@0.8.116` (#5688): the root on
 * the release nx migrate targeted, each project on the release it was
 * generated or last edited with.
 */
async function migratedWorkspace(): Promise<Tree> {
  const tree = generatorTree();
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  updateJson(tree, rootPath, (manifest: Manifest) => {
    manifest.devDependencies['@zukhruf/nx'] = target;
    manifest.devDependencies['@zukhruf/testing'] = target;
    return manifest;
  });
  updateJson(tree, webPath, (manifest: Manifest) => {
    manifest.dependencies['@zukhruf/authentication'] = '0.8.61';
    manifest.dependencies['@zukhruf/shadcn'] = '0.8.61';
    manifest.dependencies['@zukhruf/ui'] = '0.8.61';
    return manifest;
  });
  updateJson(tree, backendPath, (manifest: Manifest) => {
    manifest.dependencies['@zukhruf/async'] = '0.8.74';
    manifest.dependencies['@zukhruf/authentication'] = '^0.8.61';
    manifest.devDependencies = {
      ...manifest.devDependencies,
      '@zukhruf/testing': '0.8.96',
    };
    return manifest;
  });
  return tree;
}

test('each @zukhruf pin of a project moves to the release nx migrate wrote in the root, in the style of its pin', async (t) => {
  const tree = await migratedWorkspace();
  const info = t.mock.method(logger, 'info', () => {});

  await moveZukhrufPinsInProjectManifests(tree);

  const web = readJson<Manifest>(tree, webPath);
  const backend = readJson<Manifest>(tree, backendPath);
  assert.deepEqual(
    {
      web: [
        web.dependencies['@zukhruf/authentication'],
        web.dependencies['@zukhruf/shadcn'],
        web.dependencies['@zukhruf/ui'],
      ],
      backend: [
        backend.dependencies['@zukhruf/async'],
        backend.dependencies['@zukhruf/authentication'],
        backend.devDependencies['@zukhruf/testing'],
      ],
    },
    {
      web: [target, target, target],
      backend: [target, `^${target}`, target],
    },
  );
  assert.deepEqual(
    info.mock.calls.map((call) => String(call.arguments[0])).toSorted(),
    [
      `move-zukhruf-pins-in-project-manifests: ${backendPath} @zukhruf/async 0.8.74 -> ${target} (#5688)`,
      `move-zukhruf-pins-in-project-manifests: ${backendPath} @zukhruf/authentication ^0.8.61 -> ^${target} (#5688)`,
      `move-zukhruf-pins-in-project-manifests: ${backendPath} @zukhruf/testing 0.8.96 -> ${target} (#5688)`,
      `move-zukhruf-pins-in-project-manifests: ${webPath} @zukhruf/authentication 0.8.61 -> ${target} (#5688)`,
      `move-zukhruf-pins-in-project-manifests: ${webPath} @zukhruf/shadcn 0.8.61 -> ${target} (#5688)`,
      `move-zukhruf-pins-in-project-manifests: ${webPath} @zukhruf/ui 0.8.61 -> ${target} (#5688)`,
    ],
  );
});

test('a package outside the packageGroup, and a pin that names no version, keep their pins', async (t) => {
  const tree = await migratedWorkspace();
  updateJson(tree, webPath, (manifest: Manifest) => {
    manifest.dependencies['@zukhruf/unpublished'] = '0.8.61';
    manifest.dependencies['@zukhruf/fs'] = 'file:../../packages/fs';
    return manifest;
  });
  const before = readJson<Manifest>(tree, webPath);
  t.mock.method(logger, 'info', () => {});

  await moveZukhrufPinsInProjectManifests(tree);

  const after = readJson<Manifest>(tree, webPath);
  const untouched = (manifest: Manifest) =>
    Object.fromEntries(
      Object.entries(manifest.dependencies).filter(
        ([name]) =>
          ![
            '@zukhruf/authentication',
            '@zukhruf/shadcn',
            '@zukhruf/ui',
          ].includes(name),
      ),
    );
  assert.equal(after.dependencies['@zukhruf/unpublished'], '0.8.61');
  assert.equal(after.dependencies['@zukhruf/fs'], 'file:../../packages/fs');
  assert.deepEqual(untouched(after), untouched(before));
  assert.deepEqual(after.devDependencies, before.devDependencies);
});

test('a second run writes and logs nothing', async (t) => {
  const tree = await migratedWorkspace();
  const info = t.mock.method(logger, 'info', () => {});
  await moveZukhrufPinsInProjectManifests(tree);
  const first = new Map(changes(tree));
  info.mock.resetCalls();

  await moveZukhrufPinsInProjectManifests(tree);

  assert.deepEqual(new Map(changes(tree)), first);
  assert.deepEqual(info.mock.calls, []);
});

test('with @zukhruf/nx at no one version in the root, no project pin moves and the log says why', async (t) => {
  const tree = await migratedWorkspace();
  updateJson(tree, rootPath, (manifest: Manifest) => {
    manifest.devDependencies['@zukhruf/nx'] = 'latest';
    return manifest;
  });
  const before = readJson<Manifest>(tree, webPath);
  const info = t.mock.method(logger, 'info', () => {});

  await moveZukhrufPinsInProjectManifests(tree);

  assert.deepEqual(readJson<Manifest>(tree, webPath), before);
  assert.deepEqual(
    info.mock.calls.map((call) => String(call.arguments[0])),
    [
      'move-zukhruf-pins-in-project-manifests: package.json pins @zukhruf/nx at latest, not at one version, so no project pin moves (#5688)',
    ],
  );
});

test('a peer range is left as it is, and logged when it excludes the release', async (t) => {
  const tree = await migratedWorkspace();
  updateJson(tree, backendPath, (manifest: Manifest) => {
    manifest.peerDependencies = {
      '@zukhruf/async': '^0.8.70',
      '@zukhruf/testing': '0.8.96',
    };
    return manifest;
  });
  const info = t.mock.method(logger, 'info', () => {});

  await moveZukhrufPinsInProjectManifests(tree);

  assert.deepEqual(readJson<Manifest>(tree, backendPath).peerDependencies, {
    '@zukhruf/async': '^0.8.70',
    '@zukhruf/testing': '0.8.96',
  });
  assert.deepEqual(
    info.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.includes('peerDependencies')),
    [
      `move-zukhruf-pins-in-project-manifests: ${backendPath} peerDependencies @zukhruf/testing 0.8.96 excludes ${target}: widen it by hand (#5688)`,
    ],
  );
});
