import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type NxJsonConfiguration, readJson, updateJson } from '@nx/devkit';

import prismaGenerator from '../../generators/prisma/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import addPrismaClientInputs from './add-prisma-client-inputs.ts';

const clientInput = { dependentTasksOutputFiles: '**/*.ts' };

/** A db package as the prisma generator wrote it before #4826: no client input. */
async function oldDbPackage() {
  const tree = generatorTree();
  await prismaGenerator(tree, { directory: 'packages/db' });
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    for (const target of ['typecheck', 'build']) {
      const entry = nxJson.targetDefaults?.[target];
      if (entry !== undefined && !Array.isArray(entry)) {
        entry.inputs = ['production', '^production'];
      }
    }
    return nxJson;
  });
  return tree;
}

test('a repo with the prisma plugin gets the client input on typecheck and build, and keeps its inputs', async () => {
  const tree = await oldDbPackage();

  await addPrismaClientInputs(tree);

  const { targetDefaults } = readJson(tree, 'nx.json');
  for (const target of ['typecheck', 'build']) {
    assert.deepEqual(
      targetDefaults[target].inputs,
      ['production', '^production', '...', clientInput],
      target,
    );
  }
});

test('a second run writes nothing', async () => {
  const tree = await oldDbPackage();
  await addPrismaClientInputs(tree);
  const after = tree.read('nx.json', 'utf-8');

  await addPrismaClientInputs(tree);

  assert.equal(tree.read('nx.json', 'utf-8'), after);
});

test('a repo without the prisma plugin gets no change', async () => {
  const tree = generatorTree();
  const before = [...changes(tree).keys()];

  await addPrismaClientInputs(tree);

  assert.deepEqual([...changes(tree).keys()], before);
});
