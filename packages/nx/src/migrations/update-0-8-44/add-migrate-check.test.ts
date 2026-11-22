import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type NxJsonConfiguration, readJson, updateJson } from '@nx/devkit';

import prismaGenerator from '../../generators/prisma/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import addMigrateCheckDefault from './add-migrate-check.ts';

test('a db package generated before #4937 gets the typecheck dependencies that the generator writes now', async () => {
  const today = generatorTree();
  await prismaGenerator(today, { directory: 'packages/db' });
  const tree = generatorTree();
  await prismaGenerator(tree, { directory: 'packages/db' });
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    const typecheck = nxJson.targetDefaults?.['typecheck'];
    assert.ok(typecheck !== undefined && !Array.isArray(typecheck));
    assert.ok(typecheck.dependsOn !== undefined);
    typecheck.dependsOn = typecheck.dependsOn.filter(
      (dependency) => dependency !== 'migrate:check',
    );
    return nxJson;
  });

  await addMigrateCheckDefault(tree);
  const after = tree.read('nx.json', 'utf-8');
  await addMigrateCheckDefault(tree);

  assert.deepEqual(
    readJson(tree, 'nx.json').targetDefaults.typecheck.dependsOn,
    readJson(today, 'nx.json').targetDefaults.typecheck.dependsOn,
  );
  assert.equal(tree.read('nx.json', 'utf-8'), after);
});

test('a repo without the prisma plugin gets no migrate:check', async () => {
  const tree = generatorTree();
  const before = [...changes(tree).keys()];

  await addMigrateCheckDefault(tree);

  assert.deepEqual([...changes(tree).keys()], before);
});
