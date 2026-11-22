import {
  type NxJsonConfiguration,
  type PluginConfiguration,
  type TargetConfiguration,
  type Tree,
  updateJson,
} from '@nx/devkit';

import { addMissingKeys } from '../add-keys.ts';

type InputDefinition = NonNullable<
  NxJsonConfiguration['namedInputs']
>[string][number];

const namedInputs: Record<string, InputDefinition[]> = {
  default: ['{projectRoot}/**/*', 'sharedGlobals'],
  // The hash of a task does not read the environment, so NODE_ENV is an input:
  // a build under another value is never served from the cache.
  production: [
    'default',
    '!{projectRoot}/eslint.config.mjs',
    '!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)',
    '!{projectRoot}/tsconfig.test.json',
    '!{projectRoot}/tsconfig.spec.json',
    { env: 'NODE_ENV' },
  ],
  sharedGlobals: [
    '{workspaceRoot}/eslint.config.mjs',
    '{workspaceRoot}/tsconfig.base.json',
  ],
};

// @zukhruf/nx/lint must come after @nx/eslint/plugin: it stops with an error
// when no @nx/eslint/plugin entry is before it.
const plugins: PluginConfiguration[] = [
  {
    plugin: '@nx/js/typescript',
    options: {
      typecheck: { targetName: 'typecheck' },
      build: {
        targetName: 'build',
        configName: 'tsconfig.lib.json',
        buildDepsName: 'build-deps',
        watchDepsName: 'watch-deps',
      },
    },
  },
  { plugin: '@nx/eslint/plugin', options: { targetName: 'lint' } },
  '@zukhruf/nx/lint',
  '@zukhruf/nx/format',
  '@zukhruf/nx/test',
];

export const pluginName = (entry: PluginConfiguration) =>
  typeof entry === 'string' ? entry : entry.plugin;

export const unique = <T>(values: T[]) => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type GeneratorDefaults = NonNullable<NxJsonConfiguration['generators']>;

/**
 * Adds the defaults of one collection's generators, for example `@nx/node`,
 * option by option. An option that is there stays, also one that the plugin
 * wrote itself a moment before.
 */
export function mergeGeneratorDefaults(
  generators: GeneratorDefaults | undefined,
  collection: string,
  defaults: Record<string, Record<string, unknown>>,
): GeneratorDefaults {
  const existing: Record<string, Record<string, unknown>> = {
    ...generators?.[collection],
  };
  for (const [generator, options] of Object.entries(defaults)) {
    existing[generator] = addMissingKeys(existing[generator], options);
  }
  return { ...generators, [collection]: existing };
}

export type TargetDefault = Partial<TargetConfiguration>;

/** Changes each entry of a target default: Nx 24 takes one entry or a list of entries. */
export function updateTargetDefault(
  nxJson: NxJsonConfiguration,
  target: string,
  update: (entry: TargetDefault) => TargetDefault,
): void {
  const targetDefaults: Record<string, TargetDefault | TargetDefault[]> =
    (nxJson.targetDefaults ??= {});
  const current = targetDefaults[target] ?? {};
  targetDefaults[target] = Array.isArray(current)
    ? current.map(update)
    : update(current);
}

/**
 * Merges the keys that the monorepo standard owns into nx.json and keeps the
 * other keys. A list gets the entries that it does not have.
 */
export function mergeNxJson(tree: Tree): void {
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    nxJson.analytics = false;
    nxJson.tui = { ...nxJson.tui, enabled: false };

    nxJson.namedInputs ??= {};
    for (const [name, inputs] of Object.entries(namedInputs)) {
      nxJson.namedInputs[name] = unique([
        ...(nxJson.namedInputs[name] ?? []),
        ...inputs,
      ]);
    }

    const entries = [...(nxJson.plugins ?? [])];
    let previous = -1;
    for (const plugin of plugins) {
      const index = entries.findIndex(
        (entry) => pluginName(entry) === pluginName(plugin),
      );
      if (index === -1) {
        entries.splice(previous + 1, 0, plugin);
        previous += 1;
      } else {
        previous = Math.max(previous, index);
      }
    }
    nxJson.plugins = entries;

    // One typecheck runs the whole gate. "..." keeps the ^typecheck of
    // @nx/js/typescript, because a dependsOn list replaces the list of an
    // earlier source.
    updateTargetDefault(nxJson, 'typecheck', (entry) => ({
      ...entry,
      dependsOn: unique([
        ...(entry.dependsOn ?? []),
        'lint',
        'format:check',
        '...',
      ]),
    }));
    // Nx 24 reports a continuous task that no task depends on as a success,
    // whatever its exit code (handleContinuousTaskExit in
    // packages/nx/src/tasks-runner/task-orchestrator.ts).
    for (const target of ['dev', 'serve', 'preview', 'serve-static']) {
      updateTargetDefault(nxJson, target, (entry) => ({
        ...entry,
        continuous: false,
      }));
    }

    addProductionNodeEnvDefaults(nxJson);
    addGeneratedSourceDefaults(nxJson);

    nxJson.sync = { ...nxJson.sync, applyChanges: true };
    return nxJson;
  });
}

/** The targets that read the source of a project, generated code included. */
export const generatedSourceReaders = [
  'typecheck',
  'build',
  'test',
  'lint',
  'dev',
];
/** The cached readers: Nx hashes no gitignored file, so they hash the generated code as a task output. */
const cachedReaders = new Set(['typecheck', 'build', 'lint']);
/** The executor-keyed default that the standard writes (node-app). Nx takes it over the `build` default. */
export const executorReader = '@nx/esbuild:esbuild';

/**
 * A task that reads generated code runs its generator first and hashes its
 * output (ADR 0019). `generate` writes the Prisma client and `sdk` the sdk-it
 * client; Nx skips a dependency on a target that the project does not have.
 * `lint` also waits for the builds of its dependencies, as typed lint reads
 * their types. `...` keeps what the plugins infer. Nx takes one default for a
 * target (an executor key over a name key, never both), so the esbuild default
 * gets the rule too when nx.json has it. init, node-app and the migrations
 * call it.
 */
export function addGeneratedSourceDefaults(nxJson: NxJsonConfiguration): void {
  const targets =
    nxJson.targetDefaults?.[executorReader] === undefined
      ? generatedSourceReaders
      : [...generatedSourceReaders, executorReader];
  for (const target of targets) {
    const reader = target === executorReader ? 'build' : target;
    updateTargetDefault(nxJson, target, (entry) => ({
      ...entry,
      dependsOn: unique([
        ...(entry.dependsOn ?? []),
        'generate',
        '^sdk',
        ...(reader === 'lint' ? ['^build'] : []),
        '...',
      ]),
      ...(cachedReaders.has(reader) && {
        inputs: unique([
          ...(entry.inputs ?? []),
          '...',
          { dependentTasksOutputFiles: '**/*.ts' },
        ]),
      }),
    }));
  }
}

/**
 * Every setup runs under production (ADR 0016): the test and serve defaults
 * set NODE_ENV=production, and a NODE_ENV that is there stays. A project
 * target's own env replaces this one, so the web keeps its development and
 * test. init and the node-env-production migration call it.
 */
export function addProductionNodeEnvDefaults(
  nxJson: NxJsonConfiguration,
): void {
  for (const target of ['test', 'serve']) {
    updateTargetDefault(nxJson, target, (entry) => ({
      ...entry,
      options: {
        ...entry.options,
        env: addMissingKeys(entry.options?.env, { NODE_ENV: 'production' }),
      },
    }));
  }
}
