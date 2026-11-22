import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type NxJsonConfiguration,
  type Tree,
  logger,
  readJson,
  updateJson,
} from '@nx/devkit';

import nodeAppGenerator from '../../generators/node-app/generator.ts';
import prismaGenerator from '../../generators/prisma/generator.ts';
import reactAppGenerator from '../../generators/react-app/generator.ts';
import { changes, generatorTree } from '../../testing/generator-tree.ts';
import type { ProjectManifest } from '../workspace.ts';
import addGeneratedSourceDefaults from './add-generated-source-defaults.ts';

/** A backend, a web and a db package, as today's generators write them. */
async function workspace(): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  return tree;
}

const generatedCode = { dependentTasksOutputFiles: '**/*.ts' };

/** The same workspace as @zukhruf/nx 0.8.57 wrote it: its reader defaults and the web test's ^sdk. */
async function oldWorkspace(): Promise<Tree> {
  const tree = await workspace();
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    nxJson.targetDefaults = {
      ...nxJson.targetDefaults,
      build: {
        cache: true,
        dependsOn: ['^sdk', 'generate', '...'],
        syncGenerators: ['@juristr/nx-tailwind-sync:source-directives'],
        inputs: ['...', generatedCode],
      },
      lint: { cache: true },
      typecheck: {
        dependsOn: [
          'lint',
          'format:check',
          '...',
          '^sdk',
          'generate',
          'migrate:check',
        ],
        inputs: ['...', generatedCode],
      },
      dev: {
        continuous: false,
        dependsOn: ['^sdk'],
        syncGenerators: ['@juristr/nx-tailwind-sync:source-directives'],
      },
      test: {
        options: { env: { NODE_ENV: 'production' } },
        dependsOn: ['...', '^sdk'],
      },
      '@nx/esbuild:esbuild': {
        cache: true,
        dependsOn: ['^build'],
        inputs: [
          'production',
          '^production',
          {
            json: '{workspaceRoot}/tsconfig.json',
            fields: ['extends', 'files', 'include'],
          },
        ],
      },
    };
    return nxJson;
  });
  updateJson(tree, 'apps/web/package.json', (manifest: ProjectManifest) => {
    const test = manifest.nx?.targets?.['test'];
    if (test !== undefined) test.dependsOn = ['^sdk'];
    return manifest;
  });
  return tree;
}

/** A target default with its lists as sets: Nx reads dependsOn and inputs in no order. */
const asSets = (nxJson: NxJsonConfiguration) =>
  Object.fromEntries(
    Object.entries(nxJson.targetDefaults ?? {}).map(([name, entry]) => [
      name,
      Array.isArray(entry)
        ? entry
        : {
            ...entry,
            dependsOn: new Set(entry.dependsOn?.map((d) => JSON.stringify(d))),
            inputs: new Set(
              entry.inputs?.map((input) => JSON.stringify(input)),
            ),
          },
    ]),
  );

test('a repo from 0.8.57 gets the target defaults and the web test target that the generators write now, and nothing is logged', async (t) => {
  const today = await workspace();
  const tree = await oldWorkspace();
  const warn = t.mock.method(logger, 'warn', () => {});

  await addGeneratedSourceDefaults(tree);

  assert.deepEqual(
    asSets(readJson(tree, 'nx.json')),
    asSets(readJson(today, 'nx.json')),
  );
  assert.deepEqual(
    readJson(tree, 'apps/web/package.json').nx.targets.test,
    readJson(today, 'apps/web/package.json').nx.targets.test,
  );
  assert.deepEqual(warn.mock.calls, []);
});

test('a second run writes nothing', async () => {
  const tree = await oldWorkspace();
  await addGeneratedSourceDefaults(tree);
  const first = new Map(changes(tree));

  await addGeneratedSourceDefaults(tree);

  assert.deepEqual(new Map(changes(tree)), first);
});

test('a repo whose nx.json init did not write gets no change', async () => {
  const tree = generatorTree();
  const before = new Map(changes(tree));

  await addGeneratedSourceDefaults(tree);

  assert.deepEqual(new Map(changes(tree)), before);
});

test('a target that hides the rule in another way is logged and stays as it was', async (t) => {
  const tree = await workspace();
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    nxJson.targetDefaults = {
      ...nxJson.targetDefaults,
      'nx:run-commands': { cache: true },
      '@nx/js:tsc': { cache: true },
    };
    return nxJson;
  });
  updateJson(tree, 'packages/db/package.json', (manifest: ProjectManifest) => {
    manifest.nx = {
      ...manifest.nx,
      targets: {
        ...manifest.nx?.targets,
        lint: { dependsOn: ['^build'] },
        generate: { dependsOn: ['^build'] },
        build: { executor: '@nx/js:tsc', dependsOn: ['...'] },
      },
    };
    return manifest;
  });
  const before = readJson(tree, 'packages/db/package.json');
  const warn = t.mock.method(logger, 'warn', () => {});

  await addGeneratedSourceDefaults(tree);

  const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
  assert.equal(logged.length, 4, logged.join('\n'));
  assert.match(logged.join('\n'), /@acme\/db:lint has its own dependsOn/);
  assert.match(logged.join('\n'), /@acme\/db:generate depends on/);
  assert.match(logged.join('\n'), /executor nx:run-commands/);
  assert.match(logged.join('\n'), /executor @nx\/js:tsc/);
  assert.deepEqual(readJson(tree, 'packages/db/package.json'), before);
});
