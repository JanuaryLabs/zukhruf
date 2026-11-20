import { type NxJsonConfiguration, type Tree, formatFiles } from '@nx/devkit';

import { addMigrateCheck } from '../../generators/prisma/generator.ts';
import { hasPlugin, updateJsonIfChanged } from '../workspace.ts';

/**
 * #4937: the prisma generator adds `migrate:check` to
 * `targetDefaults.typecheck.dependsOn`, so the typecheck of a db package
 * fails when its migrations do not build its schema (ADR 0018). A repo whose
 * nx.json lists `@zukhruf/nx/prisma` gets it; the entries that are there stay.
 */
export default async function addMigrateCheckDefault(
  tree: Tree,
): Promise<void> {
  if (!hasPlugin(tree, '@zukhruf/nx/prisma')) return;
  updateJsonIfChanged<NxJsonConfiguration>(tree, 'nx.json', addMigrateCheck);
  await formatFiles(tree);
}
