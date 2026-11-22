import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, logger, readJson, updateJson } from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import reactAppGenerator from '../../generators/react-app/generator.ts';
import {
  appPackageVersions,
  rootToolVersions,
} from '../../generators/versions.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import movePeersInProjectManifests from './move-peers-in-project-manifests.ts';

const webPath = 'apps/web/package.json';
const backendPath = 'apps/backend/package.json';

interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

/** A web and a backend, as today's generators write them. */
async function workspace(): Promise<Tree> {
  const tree = generatorTree();
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  return tree;
}

/** The same workspace with the web's React of a release before 0.8.60, as factory's apps had it. */
async function oldWorkspace(): Promise<Tree> {
  const tree = await workspace();
  updateJson(tree, webPath, (manifest: Manifest) => {
    manifest.dependencies['react'] = '19.2.8';
    manifest.dependencies['react-dom'] = '19.2.8';
    return manifest;
  });
  return tree;
}

test('a project that pins a peer above the version nx migrate writes keeps its pin', async (t) => {
  const tree = await oldWorkspace();
  updateJson(tree, webPath, (manifest: Manifest) => {
    manifest.dependencies['react'] = '99.0.0';
    return manifest;
  });
  t.mock.method(logger, 'info', () => {});

  await movePeersInProjectManifests(tree);

  assert.equal(
    readJson<Manifest>(tree, webPath).dependencies['react'],
    '99.0.0',
  );
});

test('a project that does not declare a peer another project moves does not get it', async (t) => {
  const today = await workspace();
  const tree = await oldWorkspace();
  t.mock.method(logger, 'info', () => {});

  await movePeersInProjectManifests(tree);

  assert.deepEqual(readJson(tree, backendPath), readJson(today, backendPath));
});

test('a peer that a project declares as a devDependency moves there and stays out of its dependencies', async (t) => {
  const tree = await workspace();
  updateJson(tree, webPath, (manifest: Manifest) => {
    manifest.devDependencies['prettier'] = '3.9.0';
    return manifest;
  });
  t.mock.method(logger, 'info', () => {});

  await movePeersInProjectManifests(tree);

  const manifest = readJson<Manifest>(tree, webPath);
  assert.equal(
    manifest.devDependencies['prettier'],
    rootToolVersions['prettier'],
  );
  assert.equal(manifest.dependencies['prettier'], undefined);
});

test('a web from before 0.8.60 with React 19.2.8 gets the React that nx migrate writes in the root, so npm installs one React, and each move is logged (#5296)', async (t) => {
  const today = await workspace();
  const tree = await oldWorkspace();
  const info = t.mock.method(logger, 'info', () => {});

  await movePeersInProjectManifests(tree);

  assert.deepEqual(readJson(tree, webPath), readJson(today, webPath));
  assert.deepEqual(
    info.mock.calls.map((call) => String(call.arguments[0])),
    [
      `move-peers-in-project-manifests: apps/web/package.json react 19.2.8 -> ${appPackageVersions.react} (#5296)`,
      `move-peers-in-project-manifests: apps/web/package.json react-dom 19.2.8 -> ${appPackageVersions['react-dom']} (#5296)`,
    ],
  );
});

test('a second run writes and logs nothing', async (t) => {
  const tree = await oldWorkspace();
  const info = t.mock.method(logger, 'info', () => {});
  await movePeersInProjectManifests(tree);
  const first = new Map(changes(tree));
  info.mock.resetCalls();

  await movePeersInProjectManifests(tree);

  assert.deepEqual(new Map(changes(tree)), first);
  assert.deepEqual(info.mock.calls, []);
});
