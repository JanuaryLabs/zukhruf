import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import initGenerator from './generator.ts';

interface Manifest {
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

async function manifest(path: string): Promise<Manifest> {
  const parsed: Manifest = JSON.parse(
    await readFile(new URL(path, import.meta.url), 'utf8'),
  );
  return parsed;
}

// The zukhruf root installs @zukhruf/eslint beside its peers, and npm checks
// each peer range there, so the root version of a peer is one npm accepts.
test('each peer of @zukhruf/eslint that init writes is the version the zukhruf root installs', async () => {
  const eslintPackage = await manifest('../../../../eslint/package.json');
  const zukhrufRoot = await manifest('../../../../../package.json');
  const tree = createTreeWithEmptyWorkspace({ formatter: 'none' });
  tree.delete('tsconfig.base.json');
  writeJson(tree, 'package.json', {
    name: '@acme/source',
    dependencies: {},
    devDependencies: {},
  });

  await initGenerator(tree);

  const written: Record<string, string> = readJson(
    tree,
    'package.json',
  ).devDependencies;
  const peers = Object.keys(eslintPackage.peerDependencies).filter(
    (name) => name in written,
  );
  assert.ok(peers.includes('eslint-plugin-unicorn'), peers.join(', '));
  assert.deepEqual(
    Object.fromEntries(peers.map((name) => [name, written[name]])),
    Object.fromEntries(
      peers.map((name) => [name, zukhrufRoot.devDependencies[name]]),
    ),
  );
});
