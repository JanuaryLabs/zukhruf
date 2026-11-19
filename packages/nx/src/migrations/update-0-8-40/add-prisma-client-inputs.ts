import { type NxJsonConfiguration, type Tree, formatFiles } from '@nx/devkit';

import { addPrismaTargetDefaults } from '../../generators/prisma/generator.ts';
import { hasPlugin, updateJsonIfChanged } from '../workspace.ts';

/**
 * #4826: the prisma generator adds `...` and
 * `{ "dependentTasksOutputFiles": "**\/*.ts" }` to the `inputs` of
 * `targetDefaults.typecheck` and `targetDefaults.build`, so a changed schema
 * changes the hash of a db package's build (ADR 0012 decision 6). A repo whose
 * nx.json lists `@zukhruf/nx/prisma` gets the inputs it does not have; the
 * inputs that are there stay.
 */
export default async function addPrismaClientInputs(tree: Tree): Promise<void> {
  if (!hasPlugin(tree, '@zukhruf/nx/prisma')) return;
  updateJsonIfChanged<NxJsonConfiguration>(tree, 'nx.json', (nxJson) => {
    addPrismaTargetDefaults(nxJson);
  });
  await formatFiles(tree);
}
