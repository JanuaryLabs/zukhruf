import { type NxJsonConfiguration, type Tree, formatFiles } from '@nx/devkit';

import { addGeneratedSourceDefaults } from '../../generators/init/nx-json.ts';
import { hasPlugin, updateJsonIfChanged } from '../workspace.ts';

/**
 * #4826: `...` and `{ "dependentTasksOutputFiles": "**\/*.ts" }` in the
 * `inputs` of `targetDefaults.typecheck` and `targetDefaults.build`, so a
 * changed schema changes the hash of a db package's build. A repo whose
 * nx.json lists `@zukhruf/nx/prisma` gets them through the generated-source
 * rule of init (ADR 0019), which writes them today; the entries that are
 * there stay.
 */
export default async function addPrismaClientInputs(tree: Tree): Promise<void> {
  if (!hasPlugin(tree, '@zukhruf/nx/prisma')) return;
  updateJsonIfChanged<NxJsonConfiguration>(
    tree,
    'nx.json',
    addGeneratedSourceDefaults,
  );
  await formatFiles(tree);
}
