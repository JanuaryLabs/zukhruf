import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type NxJsonConfiguration, readJson, updateJson } from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import addPortlessProxyEnv from './add-portless-proxy-env.ts';

/** A backend as node-app wrote it before #4768: a portless target, no proxy env. */
async function oldBackend() {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    delete nxJson.targetDefaults?.['portless'];
    return nxJson;
  });
  return tree;
}

test('a repo with a portless target gets the unprivileged HTTPS proxy env, with no TLD', async () => {
  const tree = await oldBackend();

  await addPortlessProxyEnv(tree);

  assert.deepEqual(readJson(tree, 'nx.json').targetDefaults.portless, {
    options: { env: { PORTLESS_UNPRIVILEGED: '1', PORTLESS_HTTPS: '1' } },
  });
});

test('a proxy env that is there keeps its values', async () => {
  const tree = await oldBackend();
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    nxJson.targetDefaults = {
      ...nxJson.targetDefaults,
      portless: { options: { env: { PORTLESS_HTTPS: '0' } } },
    };
    return nxJson;
  });

  await addPortlessProxyEnv(tree);

  assert.deepEqual(
    readJson(tree, 'nx.json').targetDefaults.portless.options.env,
    { PORTLESS_HTTPS: '0', PORTLESS_UNPRIVILEGED: '1' },
  );
});

test('a second run writes nothing', async () => {
  const tree = await oldBackend();
  await addPortlessProxyEnv(tree);
  const after = tree.read('nx.json', 'utf-8');

  await addPortlessProxyEnv(tree);

  assert.equal(tree.read('nx.json', 'utf-8'), after);
});

test('a repo with no portless target gets no change', async () => {
  const tree = generatorTree();
  const before = [...changes(tree).keys()];

  await addPortlessProxyEnv(tree);

  assert.deepEqual([...changes(tree).keys()], before);
});
