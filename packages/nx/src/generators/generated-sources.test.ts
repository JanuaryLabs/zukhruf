import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';

import type { NxJsonConfiguration, PluginConfiguration } from '@nx/devkit';

import { test } from '@zukhruf/parameterized-test';

import { changes, generatorTree } from '../testing/generator-tree.ts';
import { workspace, zukhrufModules } from '../testing/workspace.ts';
import authGenerator from './auth/generator.ts';
import { pluginName } from './init/nx-json.ts';
import nodeAppGenerator from './node-app/generator.ts';
import pairGenerator from './pair/generator.ts';
import prismaGenerator from './prisma/generator.ts';
import reactAppGenerator from './react-app/generator.ts';
import uiPackageGenerator from './ui-package/generator.ts';

/** The targets that write generated code: the Prisma client and the sdk-it client. */
const producers = ['generate', 'sdk'];

/** The cached readers: a change of the generated code changes their hash. */
const hashedReaders = ['typecheck', 'build', 'lint'];
const producerOutput = { dependentTasksOutputFiles: '**/*.ts' };

/** The tasks that read no generated code, by target name or task id, each with its reason. */
const nonReaders = new Map([
  ['generate', 'a producer: it writes the Prisma client'],
  ['sdk', 'a producer: it writes the sdk-it client'],
  ['format', 'Prettier writes the source; generated code is ignored'],
  ['format:check', 'Prettier reads the source; generated code is ignored'],
  ['migrate:check', 'prisma migrate diff reads the schema and the migrations'],
  ['migrate:create', 'prisma migrate dev --create-only reads the schema'],
  ['deploy', 'prisma migrate deploy reads the migrations'],
  ['reset', 'prisma migrate reset reads the migrations'],
  ['pull', 'prisma db pull writes the schema from the database'],
  ['up', 'docker compose starts the local Postgres'],
  ['down', 'docker compose stops the local Postgres'],
  [
    'docker:build',
    'docker build runs nx build in the image, whose graph runs the generator',
  ],
  ['docker:run', 'docker run starts the image of docker:build'],
  [
    'portless',
    'it runs nx run <project>:dev or :serve, whose graph runs the generator',
  ],
  ['build-deps', 'a no-op that runs the builds of the dependencies'],
  ['watch-deps', 'it watches the builds of the dependencies'],
  [
    '@acme/backend-client:typecheck',
    'the client tsconfig has "files": [], so tsc checks nothing',
  ],
]);

/** The Nx task graph that `nx run-many --graph=stdout` prints. */
interface TaskGraph {
  tasks: {
    tasks: Record<string, { target: { project: string; target: string } }>;
    dependencies: Record<string, { id: string }[]>;
  };
}

interface ProjectGraph {
  graph: {
    nodes: Record<
      string,
      {
        data: {
          targets: Record<string, { inputs?: unknown[] }>;
        };
      }
    >;
    dependencies: Record<string, { target: string }[]>;
  };
}

/**
 * The plugins of the generated nx.json that the temp workspace can load.
 * `@zukhruf/nx/lint` stops on a linked @zukhruf/eslint ("outside the
 * workspace and outside node_modules"), and it only adds lint inputs.
 * `@nx/vite/plugin` and `@nx/vitest` load the vite configs, which import
 * Vite plugins that zukhruf does not install. The `@zukhruf/nx` entries load
 * from this checkout.
 */
function loadablePlugins(plugins: PluginConfiguration[]) {
  const dropped = new Set([
    '@zukhruf/nx/lint',
    '@nx/vite/plugin',
    '@nx/vitest',
  ]);
  return plugins
    .filter((entry) => !dropped.has(pluginName(entry)))
    .map((entry) =>
      typeof entry === 'string' && entry.startsWith('@zukhruf/nx/')
        ? fileURLToPath(import.meta.resolve(entry))
        : entry,
    );
}

/** The workspace of a backend, a web, a db package with auth, and a ui package. */
async function generatedFiles() {
  const tree = generatorTree('@acme/source');
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await authGenerator(tree, {
    backend: 'apps/backend',
    db: 'packages/db',
    web: 'apps/web',
  });
  await uiPackageGenerator(tree, {
    directory: 'packages/ui',
    importPath: '@acme/ui',
  });
  const files: Record<string, string> = {};
  for (const [path, content] of changes(tree)) {
    if (content !== undefined) files[path] = content;
  }
  return files;
}

/**
 * The generated workspace, with the lockfile entries that Nx needs to hash a
 * task, and the names of every target of its projects. It owns the folder of
 * the workspace.
 */
async function generatedWorkspace() {
  const files = await generatedFiles();
  const nxJsonText = files['nx.json'];
  assert.ok(nxJsonText !== undefined, 'init writes nx.json');
  const nxJson: NxJsonConfiguration = JSON.parse(nxJsonText);
  await using resources = new AsyncDisposableStack();
  const probe = resources.use(
    await workspace({
      files: {
        ...files,
        'nx.json': JSON.stringify({
          ...nxJson,
          plugins: loadablePlugins(nxJson.plugins ?? []),
        }),
        // @zukhruf/nx/test resolves each vite config to learn whether Vitest
        // owns the tests: the ui config has no `test`, the web config has one.
        'packages/ui/vite.config.ts': 'export default {};\n',
        'apps/web/vite.config.ts': 'export default { test: {} };\n',
      },
      plugins: [],
      links: [
        'nx',
        '@nx/js',
        '@nx/eslint',
        '@nx/eslint-plugin',
        'eslint',
        '@zukhruf/eslint',
        '@zukhruf/testing',
        'vite',
        '@typescript/native',
        '@types/node',
      ],
      packages: {},
    }),
  );
  const shown = await probe.nx('graph', '--file=stdout');
  assert.equal(shown.code, 0, shown.output);
  const { graph }: ProjectGraph = JSON.parse(shown.stdout);
  // Nx hashes a task only when the lockfile has a node for each of its
  // externalDependencies; the generated manifests give their versions.
  const declared = new Map<string, string>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('package.json')) continue;
    const manifest: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(content);
    for (const [name, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      declared.set(name, version);
    }
  }
  const external = new Set(
    Object.values(graph.nodes)
      .flatMap((node) => Object.values(node.data.targets))
      .flatMap((target) => target.inputs ?? [])
      .flatMap((input) =>
        typeof input === 'object' &&
        input !== null &&
        'externalDependencies' in input &&
        Array.isArray(input.externalDependencies)
          ? input.externalDependencies.map(String)
          : [],
      ),
  );
  await probe.lockfile(
    Object.fromEntries(
      [...external].map((name) => {
        const version = declared.get(name);
        assert.ok(version !== undefined, `no manifest declares ${name}`);
        return [`node_modules/${name}`, { version }];
      }),
    ),
  );
  const targets = new Set(
    Object.values(graph.nodes).flatMap((node) =>
      Object.keys(node.data.targets),
    ),
  );
  const owned = resources.move();
  return {
    probe,
    graph,
    targets,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('each task that reads generated code runs its generator first', async () => {
  await using generated = await generatedWorkspace();
  const { probe, graph, targets } = generated;

  const run = await probe.nx(
    'run-many',
    '-t',
    ...targets,
    '--graph=stdout',
    '--skip-sync',
  );

  assert.equal(run.code, 0, run.output);
  const { tasks }: TaskGraph = JSON.parse(run.stdout);
  const projectDependencies = (project: string, seen = new Set([project])) => {
    for (const { target } of graph.dependencies[project] ?? []) {
      if (!seen.has(target)) {
        seen.add(target);
        projectDependencies(target, seen);
      }
    }
    return seen;
  };
  const upstream = (id: string, seen = new Set<string>()) => {
    for (const dependency of tasks.dependencies[id] ?? []) {
      if (!seen.has(dependency.id)) {
        seen.add(dependency.id);
        upstream(dependency.id, seen);
      }
    }
    return seen;
  };
  const missing: string[] = [];
  const checked = new Set<string>();
  for (const [id, { target }] of Object.entries(tasks.tasks)) {
    if (nonReaders.has(target.target) || nonReaders.has(id)) continue;
    const before = upstream(id);
    const read = [...projectDependencies(target.project)]
      .flatMap((project) =>
        producers.map((producer) => `${project}:${producer}`),
      )
      .filter((producerId) => producerId in tasks.tasks);
    for (const producerId of read) {
      checked.add(`${target.project} reads ${producerId}`);
      if (!before.has(producerId)) {
        missing.push(`${id} runs without ${producerId}`);
      }
    }
    const configuration =
      graph.nodes[target.project]?.data.targets[target.target];
    assert.ok(configuration !== undefined, id);
    if (
      read.length > 0 &&
      hashedReaders.includes(target.target) &&
      configuration.inputs?.some((input) =>
        isDeepStrictEqual(input, producerOutput),
      ) !== true
    ) {
      missing.push(`${id} does not hash the generated code`);
    }
  }
  assert.deepEqual(missing, []);
  // The project graph holds the edges that make a project a reader.
  for (const reads of [
    '@acme/db reads @acme/db:generate',
    '@acme/backend reads @acme/db:generate',
    '@acme/web reads @acme/backend-client:sdk',
  ]) {
    assert.ok(checked.has(reads), reads);
  }
});

test('the sdk-it client runs after the db generator and hashes its output', async () => {
  await using generated = await generatedWorkspace();
  const { probe } = generated;

  const run = await probe.nx(
    'run',
    '@acme/backend-client:sdk',
    '--graph=stdout',
    '--skip-sync',
  );

  assert.equal(run.code, 0, run.output);
  const {
    tasks,
    taskPlans,
  }: TaskGraph & { taskPlans: Record<string, string[]> } = JSON.parse(
    run.stdout,
  );
  const upstream = new Set<string>();
  const walk = (id: string) => {
    for (const dependency of tasks.dependencies[id] ?? []) {
      if (!upstream.has(dependency.id)) {
        upstream.add(dependency.id);
        walk(dependency.id);
      }
    }
  };
  walk('@acme/backend-client:sdk');
  assert.ok(upstream.has('@acme/db:generate'), [...upstream].join('\n'));
  const plan = taskPlans['@acme/backend-client:sdk'];
  assert.ok(plan !== undefined, 'nx prints the plan of the sdk task');
  assert.ok(
    plan.some((input) => input.includes('packages/db/src/prisma')),
    plan.join('\n'),
  );
});

void test.each(
  ['apps/backend/src/server.ts', 'packages/db/schema.prisma'],
  (file) =>
    test(`a change of ${file} affects the client and the web`, async () => {
      await using generated = await generatedWorkspace();
      const { probe } = generated;
      // Nx reads the affected files against git, so the folder is a repository
      // with one commit, out of reach of the user's git config and hooks.
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: probe.path,
          env: {
            PATH: process.env['PATH'],
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_NAME: 'probe',
            GIT_AUTHOR_EMAIL: 'probe@example.invalid',
            GIT_COMMITTER_NAME: 'probe',
            GIT_COMMITTER_EMAIL: 'probe@example.invalid',
          },
        });
      git('init', '--quiet');
      git('add', '--all');
      git('commit', '--quiet', '--no-verify', '--message', 'generated');

      const shown = await probe.nx(
        'show',
        'projects',
        '--affected',
        `--files=${file}`,
        '--json',
      );

      assert.equal(shown.code, 0, shown.output);
      const affected: string[] = JSON.parse(shown.stdout);
      for (const project of ['@acme/backend-client', '@acme/web']) {
        assert.ok(
          affected.includes(project),
          `${file}: ${affected.join(', ')}`,
        );
      }
    }),
);

/** Each file that no tsconfig of src includes, by the project that type-checks it. */
const configFiles = [
  { project: '@acme/db', file: 'packages/db/prisma.config.ts' },
  { project: '@acme/backend', file: 'apps/backend/sdk-it.config.ts' },
  { project: 'hooks', file: '.husky/pre-push.ts' },
];

void test.each(configFiles, ({ project, file }) =>
  test(`the typecheck of ${project} hashes its config file ${file} and fails on a type error in it`, async () => {
    await using generated = await generatedWorkspace();
    const { probe } = generated;
    await probe.write(
      file,
      `${await probe.read(file)}export const probe: number = 'text';\n`,
    );

    const planned = await probe.nx(
      'run',
      `${project}:typecheck`,
      '--graph=stdout',
      '--skip-sync',
    );
    const run = await probe.nx(
      'run',
      `${project}:typecheck`,
      '--excludeTaskDependencies',
      '--skip-sync',
      '--skip-nx-cache',
    );

    assert.equal(planned.code, 0, planned.output);
    const { taskPlans }: { taskPlans: Record<string, string[]> } = JSON.parse(
      planned.stdout,
    );
    // A plan line of the project's files is `<project>:<glob>,<glob>,…`.
    const plan =
      taskPlans[`${project}:typecheck`] ??
      assert.fail(`nx prints no plan of ${project}:typecheck`);
    const globs = plan
      .filter((line) => line.startsWith(`${project}:`))
      .flatMap((line) => line.slice(project.length + 1).split(','));
    assert.ok(
      globs.some((glob) => matchesGlob(file, glob)),
      `${project}:typecheck does not hash ${file}:\n${plan.join('\n')}`,
    );
    assert.notEqual(run.code, 0, run.output);
    assert.match(
      stripVTControlCharacters(run.output),
      new RegExp(
        `${basename(file).replaceAll('.', '\\.')}:\\d+:\\d+ - error TS2322`,
      ),
    );
  }),
);

void test.each(configFiles, ({ file }) =>
  test(`typed lint finds the config file ${file} in a tsconfig of its project, with no default project`, async () => {
    await using generated = await generatedWorkspace();
    const run = spawnSync(
      process.execPath,
      [
        join(zukhrufModules, 'eslint/bin/eslint.js'),
        '--format',
        'json',
        basename(file),
      ],
      {
        cwd: join(generated.probe.path, dirname(file)),
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] },
        timeout: 60_000,
      },
    );

    assert.notEqual(run.stdout, '', run.stderr);
    const [result]: { messages: { fatal?: boolean; message: string }[] }[] =
      JSON.parse(run.stdout);
    assert.ok(result !== undefined, run.stdout);
    assert.deepEqual(
      result.messages.filter((message) => message.fatal === true),
      [],
      file,
    );
  }),
);
