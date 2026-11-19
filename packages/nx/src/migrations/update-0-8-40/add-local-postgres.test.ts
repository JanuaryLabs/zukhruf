import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, logger, readJson, updateJson } from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import prismaGenerator from '../../generators/prisma/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import addLocalPostgres from './add-local-postgres.ts';

interface Manifest {
  nx: { targets: Record<string, { dependsOn?: unknown[] }> };
}

const url = 'postgresql://postgres:postgres@127.0.0.1:5432/acme';
const envFiles = [
  'apps/backend/.env.example',
  'apps/backend/.env',
  'packages/db/.env.example',
  'packages/db/.env',
];

/** A backend and its db package as the generators wrote them before #4792. */
async function oldWorkspace(): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  tree.delete('compose.dev.yml');
  updateJson(tree, 'packages/db/package.json', (manifest: Manifest) => {
    delete manifest.nx.targets['up'];
    delete manifest.nx.targets['down'];
    return manifest;
  });
  updateJson(tree, 'apps/backend/package.json', (manifest: Manifest) => {
    const serve = manifest.nx.targets['serve'];
    if (serve?.dependsOn !== undefined) {
      serve.dependsOn = serve.dependsOn.filter((entry) => entry !== '^up');
    }
    return manifest;
  });
  for (const path of envFiles) {
    const content = tree.read(path, 'utf-8') ?? '';
    tree.write(
      path,
      content.replace(/^CONNECTION_STRING=.*$/m, 'CONNECTION_STRING='),
    );
  }
  return tree;
}

test('a db package gets the local Postgres, its targets, the local URL and ^up on its backend serve', async () => {
  const tree = await oldWorkspace();

  await addLocalPostgres(tree);

  const compose = tree.read('compose.dev.yml', 'utf-8') ?? '';
  assert.match(compose, /^ {6}- '127\.0\.0\.1:5432:5432'$/m);
  assert.match(compose, /^ {6}POSTGRES_DB: acme$/m);
  const { up, down } = readJson<Manifest>(tree, 'packages/db/package.json').nx
    .targets;
  assert.ok(up !== undefined && down !== undefined);
  assert.ok(
    readJson<Manifest>(tree, 'apps/backend/package.json').nx.targets[
      'serve'
    ]?.dependsOn?.includes('^up'),
  );
  for (const path of envFiles) {
    assert.match(
      tree.read(path, 'utf-8') ?? '',
      new RegExp(`^CONNECTION_STRING=${url}$`, 'm'),
      path,
    );
  }
});

test('the targets it writes are the ones the prisma generator writes now', async () => {
  const generated = generatorTree();
  await nodeAppGenerator(generated, { directory: 'apps/backend' });
  await prismaGenerator(generated, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  const tree = await oldWorkspace();

  await addLocalPostgres(tree);

  assert.deepEqual(
    readJson<Manifest>(tree, 'packages/db/package.json').nx.targets,
    readJson<Manifest>(generated, 'packages/db/package.json').nx.targets,
  );
  assert.equal(
    tree.read('compose.dev.yml', 'utf-8'),
    generated.read('compose.dev.yml', 'utf-8'),
  );
});

test('a CONNECTION_STRING with a value keeps it', async () => {
  const tree = await oldWorkspace();
  const own = 'PORT=3000\nCONNECTION_STRING=postgresql://localhost/app\n';
  tree.write('apps/backend/.env', own);

  await addLocalPostgres(tree);

  assert.equal(tree.read('apps/backend/.env', 'utf-8'), own);
});

test('a second run writes nothing', async () => {
  const tree = await oldWorkspace();
  await addLocalPostgres(tree);
  const files = [
    'compose.dev.yml',
    'packages/db/package.json',
    'apps/backend/package.json',
    ...envFiles,
  ];
  const first = files.map((path) => tree.read(path, 'utf-8'));

  await addLocalPostgres(tree);

  assert.deepEqual(
    files.map((path) => tree.read(path, 'utf-8')),
    first,
  );
});

test('a compose.dev.yml of another shape gets no edit, and the log names the step to take by hand', async (t) => {
  const tree = await oldWorkspace();
  const compose = 'services:\n  redis:\n    image: redis:8-alpine\n';
  tree.write('compose.dev.yml', compose);
  const warn = t.mock.method(logger, 'warn', () => {});

  await addLocalPostgres(tree);

  assert.equal(tree.read('compose.dev.yml', 'utf-8'), compose);
  assert.equal(
    readJson<Manifest>(tree, 'packages/db/package.json').nx.targets['up'],
    undefined,
  );
  assert.match(
    String(warn.mock.calls[0]?.arguments[0]),
    /compose\.dev\.yml has no service "database"/,
  );
});

test('a repo with no db package gets no change', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  const before = [...changes(tree).entries()];

  await addLocalPostgres(tree);

  assert.deepEqual([...changes(tree).entries()], before);
});
