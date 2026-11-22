import assert from 'node:assert/strict';
import { test } from 'node:test';

import { logger } from '@nx/devkit';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import renameEslintReactConfig from './rename-eslint-react-config.ts';

const path = 'apps/web/eslint.config.mjs';

test('configs with the name react in single quotes becomes shadcn', async (t) => {
  const info = t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import zukhruf from '@zukhruf/eslint';\n\nexport default [...zukhruf.configs['base'], ...zukhruf.configs['react']];\n`,
  );

  await renameEslintReactConfig(tree);

  assert.equal(
    tree.read(path, 'utf8'),
    `import zukhruf from '@zukhruf/eslint';\n\nexport default [...zukhruf.configs['base'], ...zukhruf.configs['shadcn']];\n`,
  );
  assert.deepEqual(
    info.mock.calls.map((call) => call.arguments[0]),
    [
      `rename-eslint-react-config: ${path}:3 zukhruf.configs['react'] -> zukhruf.configs['shadcn']`,
    ],
  );
});

test('configs with the name react in double quotes becomes shadcn', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs["react"]];\n`,
  );

  await renameEslintReactConfig(tree);

  assert.equal(
    tree.read(path, 'utf8'),
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs['shadcn']];\n`,
  );
});

test('configs.react becomes shadcn', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs.react, ...zukhruf.configs.base];\n`,
  );

  await renameEslintReactConfig(tree);

  assert.equal(
    tree.read(path, 'utf8'),
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs['shadcn'], ...zukhruf.configs.base];\n`,
  );
});

test('the default import of @zukhruf/eslint is found by its local name', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import kit, { noUnassignedImport } from '@zukhruf/eslint';\nexport default [...kit.configs['react'], ...zukhruf.configs['react']];\n`,
  );

  await renameEslintReactConfig(tree);

  assert.equal(
    tree.read(path, 'utf8'),
    `import kit, { noUnassignedImport } from '@zukhruf/eslint';\nexport default [...kit.configs['shadcn'], ...zukhruf.configs['react']];\n`,
  );
});

test("'zukhruf/react' in an extends array becomes 'zukhruf/shadcn', and 'zukhruf/react-router' stays", async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import zukhruf from '@zukhruf/eslint';\nexport default [{ plugins: { zukhruf }, extends: ['zukhruf/base', "zukhruf/react", 'zukhruf/react-router'] }];\n`,
  );

  await renameEslintReactConfig(tree);

  assert.equal(
    tree.read(path, 'utf8'),
    `import zukhruf from '@zukhruf/eslint';\nexport default [{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/shadcn', 'zukhruf/react-router'] }];\n`,
  );
});

test("'zukhruf/react' outside an extends array stays", async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  const before = `import zukhruf from '@zukhruf/eslint';\nexport default [{ files: ['zukhruf/react'], settings: { name: 'zukhruf/react' } }];\n`;
  tree.write(path, before);

  await renameEslintReactConfig(tree);

  assert.equal(tree.read(path, 'utf8'), before);
});

test('react under another key of the plugin stays', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  const before = `import zukhruf from '@zukhruf/eslint';\nexport default [{ rules: zukhruf.rules['react'] }, zukhruf.react];\n`;
  tree.write(path, before);

  await renameEslintReactConfig(tree);

  assert.equal(tree.read(path, 'utf8'), before);
});

test('the community React preset @zukhruf/eslint/react stays', async (t) => {
  const info = t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  const before = `import react from '@zukhruf/eslint/react';\nexport default [...react, ...react.configs['react']];\n`;
  tree.write(path, before);

  await renameEslintReactConfig(tree);

  assert.equal(tree.read(path, 'utf8'), before);
  assert.equal(info.mock.callCount(), 0);
});

test('a file that reads the shadcn config already is unchanged', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs['shadcn'], { extends: ['zukhruf/shadcn'] }];\n`,
  );
  const changed = changes(tree);

  await renameEslintReactConfig(tree);

  assert.deepEqual(changes(tree), changed);
});

test('a second run changes nothing', async (t) => {
  const info = t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  tree.write(
    path,
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs.react, { extends: ['zukhruf/react'] }];\n`,
  );
  await renameEslintReactConfig(tree);
  const once = tree.read(path, 'utf8');

  await renameEslintReactConfig(tree);

  assert.equal(tree.read(path, 'utf8'), once);
  assert.equal(info.mock.callCount(), 2);
});

test('only files named eslint.config change', async (t) => {
  t.mock.method(logger, 'info', () => {});
  const tree = generatorTree();
  const text = `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs['react']];\n`;
  tree.write('eslint.config.ts', text);
  tree.write('apps/web/lint.mjs', text);

  await renameEslintReactConfig(tree);

  assert.equal(
    tree.read('eslint.config.ts', 'utf8'),
    `import zukhruf from '@zukhruf/eslint';\nexport default [...zukhruf.configs['shadcn']];\n`,
  );
  assert.equal(tree.read('apps/web/lint.mjs', 'utf8'), text);
});
