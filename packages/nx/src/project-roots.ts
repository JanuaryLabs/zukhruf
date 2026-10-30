import { basename, dirname, join } from 'node:path';

import { readJsonFile } from '@nx/devkit';
import {
  buildPackageJsonPatterns,
  buildPackageJsonWorkspacesMatcher,
} from '@nx/devkit/internal';

/**
 * Any root that a plugin returns becomes a project, and no plugin hook
 * receives the projects that Nx found. So each area selects roots with the
 * rule and the matcher of Nx's own package.json plugin: each folder with a
 * `project.json`, and a `package.json` folder only when the package-manager
 * workspace globs match it (ADR 0003). Gives the `project.json` or
 * `package.json` file of each root.
 */
export function projectRootFiles(
  configFiles: readonly string[],
  workspaceRoot: string,
): string[] {
  const projectJsonRoots = new Set(
    configFiles
      .filter((file) => basename(file) === 'project.json')
      .map((file) => dirname(file)),
  );
  const isInWorkspaces = buildPackageJsonWorkspacesMatcher(
    buildPackageJsonPatterns(workspaceRoot, (file: string) =>
      readJsonFile(join(workspaceRoot, file)),
    ),
  );
  return configFiles.filter((file) =>
    basename(file) === 'project.json'
      ? true
      : !projectJsonRoots.has(dirname(file)) && isInWorkspaces(file),
  );
}
