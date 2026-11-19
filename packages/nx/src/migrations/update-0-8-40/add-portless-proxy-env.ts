import {
  type NxJsonConfiguration,
  type Tree,
  formatFiles,
  getProjects,
} from '@nx/devkit';

import { addPortlessProxyEnv } from '../../generators/portless-env.ts';
import { updateJsonIfChanged } from '../workspace.ts';

/**
 * #4768: node-app and react-app add PORTLESS_UNPRIVILEGED=1 and
 * PORTLESS_HTTPS=1 to `targetDefaults.portless.options.env` in nx.json. A
 * repo with a `portless` target gets the keys it does not have; a key that is
 * there stays, and no PORTLESS_TLD is added.
 */
export default async function addPortlessProxyEnvMigration(
  tree: Tree,
): Promise<void> {
  const portless = getProjects(tree)
    .values()
    .some((project) => project.targets?.['portless'] !== undefined);
  if (!portless) return;
  updateJsonIfChanged<NxJsonConfiguration>(tree, 'nx.json', (nxJson) => {
    addPortlessProxyEnv(nxJson);
  });
  await formatFiles(tree);
}
