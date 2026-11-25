import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Tree, logger, readJson, updateJson } from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import prismaGenerator from '../../generators/prisma/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import typeCheckConfigFiles from './type-check-config-files.ts';

interface Tsconfig {
  include?: string[];
  references?: { path: string }[];
}

/** The root block of init/files.ts up to 0.8.115. */
const rootBlock = `  // Files that no tsconfig includes get the default project of typed lint,
  // not a parse error. typescript-eslint refuses '**' here.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.ts', '.husky/*.ts'],
        },
      },
    },
  },
`;

/** The project block of node-app/files.ts and prisma/files.ts up to 0.8.115. */
const projectBlock = (projectRoot: string, file: string) =>
  `  // No tsconfig of the project includes ${file}, so typed lint gives
  // it the default project. The path is relative to the workspace root, the
  // tsconfigRootDir of @zukhruf/eslint. The block takes each .ts file, as the
  // root block does: one project service serves the process, with the options
  // of the first file it parses.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['${projectRoot}/${file}'],
        },
      },
    },
  },
`;

/** The paths the change of #5649 adds or edits. */
const paths = [
  'tsconfig.json',
  'eslint.config.mjs',
  '.husky/project.json',
  '.husky/tsconfig.json',
  'apps/backend/tsconfig.json',
  'apps/backend/tsconfig.scripts.json',
  'apps/backend/eslint.config.mjs',
  'packages/db/tsconfig.json',
  'packages/db/tsconfig.scripts.json',
  'packages/db/eslint.config.mjs',
];

/** A backend and a db package, as today's generators write them. */
async function workspace(): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, { directory: 'packages/db' });
  return tree;
}

function addBlock(tree: Tree, path: string, block: string): void {
  const text = tree.read(path, 'utf8') ?? '';
  assert.match(text, /\n\];\n$/, path);
  tree.write(path, text.replace(/\];\n$/, `${block}];\n`));
}

function dropReference(tree: Tree, path: string, reference: string): void {
  updateJson(tree, path, (tsconfig: Tsconfig) => ({
    ...tsconfig,
    references: tsconfig.references?.filter(({ path }) => path !== reference),
  }));
}

/** The same workspace as @zukhruf/nx 0.8.115 wrote it: allowDefaultProject blocks, no scripts tsconfigs, no hooks project. */
async function oldWorkspace(): Promise<Tree> {
  const tree = await workspace();
  addBlock(tree, 'eslint.config.mjs', rootBlock);
  addBlock(
    tree,
    'apps/backend/eslint.config.mjs',
    projectBlock('apps/backend', 'sdk-it.config.ts'),
  );
  addBlock(
    tree,
    'packages/db/eslint.config.mjs',
    projectBlock('packages/db', 'prisma.config.ts'),
  );
  for (const root of ['apps/backend', 'packages/db']) {
    tree.delete(`${root}/tsconfig.scripts.json`);
    dropReference(tree, `${root}/tsconfig.json`, './tsconfig.scripts.json');
  }
  tree.delete('.husky/project.json');
  tree.delete('.husky/tsconfig.json');
  dropReference(tree, 'tsconfig.json', './.husky');
  return tree;
}

/** The text of each path, with the root references in a set: their order means nothing to tsc. */
function snapshot(tree: Tree): Record<string, unknown> {
  return Object.fromEntries(
    paths.map((path) => {
      if (path !== 'tsconfig.json') return [path, tree.read(path, 'utf8')];
      const { references = [], ...rest } = readJson<Tsconfig>(tree, path);
      return [
        path,
        { ...rest, references: new Set(references.map(({ path }) => path)) },
      ];
    }),
  );
}

function warnings(calls: { arguments: unknown[] }[]): string[] {
  return calls.map(({ arguments: [line] }) => String(line));
}

test('a repo from 0.8.115 gets the tsconfigs and eslint configs that init, node-app and prisma write now, and nothing is logged', async (t) => {
  const today = await workspace();
  const tree = await oldWorkspace();
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.deepEqual(snapshot(tree), snapshot(today));
  assert.deepEqual(warnings(warn.mock.calls), []);
});

test('a second run writes and logs nothing', async (t) => {
  const tree = await oldWorkspace();
  await typeCheckConfigFiles(tree);
  const first = changes(tree);
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.deepEqual(changes(tree), first);
  assert.deepEqual(warnings(warn.mock.calls), []);
});

test('a hand-written allowDefaultProject block stays, the files it names get no tsconfig, and one log names its file and the fix', async (t) => {
  const tree = await oldWorkspace();
  const before = changes(tree);
  // whatisgoingon's root block, which names each depth by hand.
  const handBlock = `  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.config.ts',
            '.husky/*.ts',
            'apps/*/sdk-it.config.ts',
          ],
        },
      },
    },
  },
`;
  const root = tree.read('eslint.config.mjs', 'utf8') ?? '';
  tree.write('eslint.config.mjs', root.replace(rootBlock, handBlock));
  const handRoot = tree.read('eslint.config.mjs', 'utf8');
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.equal(tree.read('eslint.config.mjs', 'utf8'), handRoot);
  assert.equal(tree.exists('apps/backend/tsconfig.scripts.json'), false);
  assert.equal(
    tree.read('apps/backend/eslint.config.mjs', 'utf8'),
    before.get('apps/backend/eslint.config.mjs'),
  );
  assert.equal(tree.exists('.husky/project.json'), false);
  assert.equal(tree.exists('.husky/tsconfig.json'), false);
  assert.ok(
    !readJson<Tsconfig>(tree, 'tsconfig.json').references?.some(
      ({ path }) => path === './.husky',
    ),
  );
  // The db package is not named by the hand block, so it moves on.
  assert.ok(tree.exists('packages/db/tsconfig.scripts.json'));
  assert.doesNotMatch(
    tree.read('packages/db/eslint.config.mjs', 'utf8') ?? '',
    /allowDefaultProject/,
  );
  const logged = warnings(warn.mock.calls);
  assert.equal(logged.length, 3, logged.join('\n'));
  const [hand, backend, hooks] = [
    logged.find((line) =>
      line.startsWith('type-check-config-files: eslint.config.mjs:'),
    ),
    logged.find((line) => line.includes('apps/backend/tsconfig.scripts.json')),
    logged.find((line) => line.includes('.husky/project.json')),
  ];
  assert.match(hand ?? '', /eslint\.config\.mjs:\d+/);
  assert.match(hand ?? '', /tsconfig\.scripts\.json/);
  assert.match(backend ?? '', /with 'apps\/\*\/sdk-it\.config\.ts'/);
  assert.match(backend ?? '', /"include":\["sdk-it\.config\.ts"\]/);
  assert.match(hooks ?? '', /with '\.husky\/\*\.ts'/);
});

test('a hand-written block that names no file this change covers stays and is logged, and the change goes ahead', async (t) => {
  const tree = await oldWorkspace();
  const handBlock = `  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['apps/backend/scripts/*.ts'] },
      },
    },
  },
`;
  const path = 'apps/backend/eslint.config.mjs';
  const text = tree.read(path, 'utf8') ?? '';
  tree.write(
    path,
    text.replace(projectBlock('apps/backend', 'sdk-it.config.ts'), handBlock),
  );
  const hand = tree.read(path, 'utf8');
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.equal(tree.read(path, 'utf8'), hand);
  assert.ok(tree.exists('apps/backend/tsconfig.scripts.json'));
  const logged = warnings(warn.mock.calls);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0] ?? '', /apps\/backend\/eslint\.config\.mjs:\d+/);
  assert.match(logged[0] ?? '', /'apps\/backend\/scripts\/\*\.ts'/);
});

test('a .husky/project.json of another name stays, and the root block goes because its tsconfig covers the hooks', async (t) => {
  const tree = await oldWorkspace();
  // Meddit's hooks project, made by hand before init wrote one.
  const project = { name: '@acme/hooks', projectType: 'application' };
  updateJson(tree, 'tsconfig.json', (tsconfig: Tsconfig) => ({
    ...tsconfig,
    references: [{ path: './.husky' }],
  }));
  tree.write('.husky/project.json', JSON.stringify(project));
  tree.write('.husky/tsconfig.json', JSON.stringify({ include: ['*.ts'] }));
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.deepEqual(readJson(tree, '.husky/project.json'), project);
  assert.deepEqual(readJson(tree, '.husky/tsconfig.json'), {
    include: ['*.ts'],
  });
  assert.doesNotMatch(
    tree.read('eslint.config.mjs', 'utf8') ?? '',
    /allowDefaultProject/,
  );
  assert.deepEqual(warnings(warn.mock.calls), []);
});

test('the root block and the hooks stay while a root *.config.ts has no tsconfig, and one log names the file and both edits', async (t) => {
  const tree = await oldWorkspace();
  tree.write('vitest.config.ts', 'export default {};\n');
  const root = tree.read('eslint.config.mjs', 'utf8');
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.equal(tree.read('eslint.config.mjs', 'utf8'), root);
  assert.equal(tree.exists('.husky/project.json'), false);
  assert.equal(tree.exists('.husky/tsconfig.json'), false);
  const logged = warnings(warn.mock.calls);
  assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0] ?? '', /vitest\.config\.ts/);
  assert.match(logged[0] ?? '', /\.husky\/project\.json/);
});

test('a tsconfig.scripts.json written by hand stays, and the block of its project goes because it covers the file', async (t) => {
  const tree = await oldWorkspace();
  // Meddit's db package type-checks its scripts beside prisma.config.ts.
  const scripts = { include: ['prisma.config.ts', 'scripts/**/*.ts'] };
  tree.write('packages/db/tsconfig.scripts.json', JSON.stringify(scripts));
  updateJson(tree, 'packages/db/tsconfig.json', (tsconfig: Tsconfig) => ({
    ...tsconfig,
    references: [
      ...(tsconfig.references ?? []),
      { path: './tsconfig.scripts.json' },
    ],
  }));
  const warn = t.mock.method(logger, 'warn', () => {});

  await typeCheckConfigFiles(tree);

  assert.deepEqual(
    readJson(tree, 'packages/db/tsconfig.scripts.json'),
    scripts,
  );
  assert.doesNotMatch(
    tree.read('packages/db/eslint.config.mjs', 'utf8') ?? '',
    /allowDefaultProject/,
  );
  assert.deepEqual(warnings(warn.mock.calls), []);
});

test('a .husky/tsconfig.json with no project.json stays, and the hooks get the project.json init writes', async () => {
  const tree = await oldWorkspace();
  const hooksTsconfig = { extends: '../tsconfig.base.json', include: ['*.ts'] };
  tree.write('.husky/tsconfig.json', JSON.stringify(hooksTsconfig));

  await typeCheckConfigFiles(tree);

  assert.deepEqual(readJson(tree, '.husky/tsconfig.json'), hooksTsconfig);
  assert.equal(readJson(tree, '.husky/project.json').name, 'hooks');
});
