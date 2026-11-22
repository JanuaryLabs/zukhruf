import { isDeepStrictEqual } from 'node:util';

import {
  type NxJsonConfiguration,
  type TargetDependencyConfig,
  type Tree,
  formatFiles,
  getProjects,
  joinPathFragments,
  logger,
  readJson,
} from '@nx/devkit';

import {
  addGeneratedSourceDefaults,
  executorReader,
  generatedSourceReaders,
} from '../../generators/init/nx-json.ts';
import {
  type ProjectManifest,
  hasPlugin,
  updateJsonIfChanged,
} from '../workspace.ts';

/** The plugins that init writes, all three since its first version (e35fc327). */
const initPlugins = [
  '@zukhruf/nx/lint',
  '@zukhruf/nx/format',
  '@zukhruf/nx/test',
];

/**
 * #5219, ADR 0019: a task that reads generated code runs its generator first
 * and hashes its output. A repo whose nx.json init wrote gets the rule of
 * init; the entries that are there stay. The web's `test` target loses the
 * `dependsOn: ["^sdk"]` that react-app wrote, which hid the rule from it. A
 * project target that hides the rule in another way is logged, not edited
 * (ADR 0017 decision 5).
 */
export default async function addGeneratedSourceDefaultsMigration(
  tree: Tree,
): Promise<void> {
  if (!initPlugins.every((plugin) => hasPlugin(tree, plugin))) return;
  updateJsonIfChanged<NxJsonConfiguration>(
    tree,
    'nx.json',
    addGeneratedSourceDefaults,
  );
  for (const project of getProjects(tree).values()) {
    const path = joinPathFragments(project.root, 'package.json');
    if (!tree.exists(path)) continue;
    updateJsonIfChanged<ProjectManifest>(tree, path, (manifest) => {
      const test = manifest.nx?.targets?.['test'];
      if (test !== undefined && isDeepStrictEqual(test.dependsOn, ['^sdk'])) {
        delete test.dependsOn;
      }
    });
  }
  logShadows(tree);
  await formatFiles(tree);
}

const targetName = (dependency: string | TargetDependencyConfig) =>
  typeof dependency === 'string'
    ? dependency.replace(/^\^/, '')
    : dependency.target;

/**
 * A project target replaces the dependsOn of the default, and an executor
 * default replaces the name default, so each one hides the rule. A project
 * `generate` that waits for a reader makes a cycle with it.
 */
function logShadows(tree: Tree): void {
  const { targetDefaults } = readJson<NxJsonConfiguration>(tree, 'nx.json');
  // The inferred readers of @nx/js/typescript, @nx/eslint and @zukhruf/nx/test
  // run on nx:run-commands; a project target names its own executor.
  const executors = new Set(['nx:run-commands']);
  for (const [name, project] of getProjects(tree)) {
    for (const [target, configuration] of Object.entries(
      project.targets ?? {},
    )) {
      const { dependsOn, executor } = configuration;
      if (generatedSourceReaders.includes(target)) {
        if (executor !== undefined) executors.add(executor);
        if (dependsOn !== undefined && !dependsOn.includes('...')) {
          logger.warn(
            `add-generated-source-defaults: ${name}:${target} has its own dependsOn ${JSON.stringify(dependsOn)} with no "...", so it does not run generate and ^sdk first. Add "..." to it, or remove it (ADR 0019 of @zukhruf/nx).`,
          );
        }
      }
      if (
        target === 'generate' &&
        dependsOn !== undefined &&
        dependsOn.some((dependency) =>
          generatedSourceReaders.includes(targetName(dependency)),
        )
      ) {
        logger.warn(
          `add-generated-source-defaults: ${name}:generate depends on ${JSON.stringify(dependsOn)}, and each reader now runs generate first, so the two make a cycle. Remove the reader from its dependsOn (ADR 0019 of @zukhruf/nx).`,
        );
      }
    }
  }
  for (const executor of executors) {
    if (
      executor !== executorReader &&
      targetDefaults?.[executor] !== undefined
    ) {
      logger.warn(
        `add-generated-source-defaults: targetDefaults has an entry for the executor ${executor}, which Nx takes over the entry of the target name, so its targets do not run generate and ^sdk first. Add "generate", "^sdk" and "..." to its dependsOn (ADR 0019 of @zukhruf/nx).`,
      );
    }
  }
}
