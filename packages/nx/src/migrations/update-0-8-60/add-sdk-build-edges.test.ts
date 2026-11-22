import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, logger, readJson, updateJson } from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import type { ProjectManifest } from '../workspace.ts';
import addSdkBuildEdges from './add-sdk-build-edges.ts';

const backendPath = 'apps/backend/package.json';
const clientPath = 'apps/backend/.sdk-it/package.json';

/** A backend and its client stub, as today's node-app writes them. */
async function workspace(): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  return tree;
}

/** The same backend and stub as @zukhruf/nx 0.8.59 wrote them: no build-deps, no edge to the backend. */
async function oldWorkspace(): Promise<Tree> {
  const tree = await workspace();
  updateJson(tree, backendPath, (manifest: ProjectManifest) => {
    delete manifest.nx?.targets?.['build-deps'];
    return manifest;
  });
  updateJson(
    tree,
    clientPath,
    (manifest: {
      nx: {
        implicitDependencies?: string[];
        targets: { sdk: { dependsOn?: string[]; inputs: unknown[] } };
      };
    }) => {
      delete manifest.nx.implicitDependencies;
      delete manifest.nx.targets.sdk.dependsOn;
      manifest.nx.targets.sdk.inputs = [
        { projects: ['@acme/backend'], input: 'production' },
        '{workspaceRoot}/package-lock.json',
        '{projectRoot}/package.json',
      ];
      return manifest;
    },
  );
  return tree;
}

test('a backend and client from 0.8.59 get the build-deps and the sdk edge that node-app writes now, and nothing is logged', async (t) => {
  const today = await workspace();
  const tree = await oldWorkspace();
  const warn = t.mock.method(logger, 'warn', () => {});

  await addSdkBuildEdges(tree);

  assert.deepEqual(readJson(tree, backendPath), readJson(today, backendPath));
  assert.deepEqual(readJson(tree, clientPath), readJson(today, clientPath));
  assert.deepEqual(warn.mock.calls, []);
});

test('a second run writes and logs nothing', async (t) => {
  const tree = await oldWorkspace();
  await addSdkBuildEdges(tree);
  const first = new Map(changes(tree));
  const warn = t.mock.method(logger, 'warn', () => {});

  await addSdkBuildEdges(tree);

  assert.deepEqual(new Map(changes(tree)), first);
  assert.deepEqual(warn.mock.calls, []);
});

test('a client sdk edited by hand is logged with what to write, and stays as it was', async (t) => {
  const tree = await oldWorkspace();
  // Meddit's client waits for the db generator by name.
  updateJson(
    tree,
    clientPath,
    (manifest: { nx: { targets: { sdk: { dependsOn?: unknown[] } } } }) => {
      manifest.nx.targets.sdk.dependsOn = [
        { projects: ['@acme/db'], target: 'generate' },
      ];
      return manifest;
    },
  );
  const before = readJson(tree, clientPath);
  const warn = t.mock.method(logger, 'warn', () => {});

  await addSdkBuildEdges(tree);

  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0] ?? '', /apps\/backend\/\.sdk-it\/package\.json/);
  assert.match(logged[0] ?? '', /"implicitDependencies": \["@acme\/backend"\]/);
  assert.match(logged[0] ?? '', /dependsOn with \["\^build-deps"\]/);
  assert.match(
    logged[0] ?? '',
    /"\^production",\{"dependentTasksOutputFiles":"\*\*\/\*\.ts","transitive":true\}/,
  );
  assert.deepEqual(readJson(tree, clientPath), before);
  assert.deepEqual(
    readJson(tree, backendPath).nx.targets['build-deps'],
    readJson(await workspace(), backendPath).nx.targets['build-deps'],
  );
});
