import { readFileSync } from 'node:fs';

import {
  type Tree,
  addDependenciesToPackageJson,
  formatFiles,
  getProjects,
  joinPathFragments,
  logger,
  readJson,
} from '@nx/devkit';

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

type Section = keyof Manifest;

const sections: readonly Section[] = ['dependencies', 'devDependencies'];

/** The packages that each `packageJsonUpdates` entry of this package moves, with their versions. */
function packageJsonUpdates(): Record<string, string>[] {
  const migrations: {
    packageJsonUpdates: Record<
      string,
      { packages: Record<string, { version: string }> }
    >;
  } = JSON.parse(
    readFileSync(new URL('../../../migrations.json', import.meta.url), 'utf-8'),
  );
  return Object.values(migrations.packageJsonUpdates).map(({ packages }) =>
    Object.fromEntries(
      Object.entries(packages).map(([name, { version }]) => [name, version]),
    ),
  );
}

/**
 * #5296: `nx migrate` writes `packageJsonUpdates` in the root package.json
 * only (nx 24.0.6 migrate.js updatePackageJson), but the generators pin a peer
 * such as react in each app's own package.json too, so npm installs a second
 * copy for the app. Each project's package.json gets the same versions for the
 * packages it declares, and only those. Nx's addDependenciesToPackageJson moves
 * a package in the section that declares it and never moves a version down, so
 * the entries apply in any order and the newest wins.
 */
export default async function movePeersInProjectManifests(
  tree: Tree,
): Promise<void> {
  const updates = packageJsonUpdates();
  for (const [, { root }] of getProjects(tree)) {
    const path = joinPathFragments(root, 'package.json');
    if (!tree.exists(path)) continue;
    const before = readJson<Manifest>(tree, path);
    for (const update of updates)
      addDependenciesToPackageJson(tree, declared(before, update), {}, path);
    const after = readJson<Manifest>(tree, path);
    for (const section of sections)
      for (const [name, version] of Object.entries(before[section] ?? {}))
        if (after[section]?.[name] !== version)
          logger.info(
            `move-peers-in-project-manifests: ${path} ${name} ${version} -> ${after[section]?.[name]} (#5296)`,
          );
  }
  await formatFiles(tree);
}

/** The packages of `update` that a manifest declares, in either section. */
function declared(
  manifest: Manifest,
  update: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(update).filter(([name]) =>
      sections.some((section) => manifest[section]?.[name] !== undefined),
    ),
  );
}
