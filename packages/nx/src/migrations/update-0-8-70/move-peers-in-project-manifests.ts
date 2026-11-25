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
 * copy for the app. A project's package.json gets an entry's version of a
 * package it declares only when the root package.json declares that package at
 * that version, so the project and the root install one copy.
 *
 * #5689: Nx calls a migration with the tree alone (nx 24.0.6
 * execute-migration.js runNxMigration, `fn(host, {})`) and records no starting
 * version in migrations.json (migrate.js `{ ...migration, package, name }`), so
 * the migration cannot read the window nx migrate ran. The root shows it: nx
 * migrate writes an entry's version in the root only for a package the root
 * declares and an entry no older than the installed @zukhruf/nx (migrate.js
 * filterPackageJsonUpdates, shouldApplyPackageUpdate), so an entry older than
 * the repo leaves the root on its own version and moves no project. Nx's
 * addDependenciesToPackageJson moves a package in the section that declares it
 * and never moves a version down.
 */
export default async function movePeersInProjectManifests(
  tree: Tree,
): Promise<void> {
  const root = readJson<Manifest>(tree, 'package.json');
  const updates = packageJsonUpdates().map((update) =>
    writtenInRoot(root, update),
  );
  const moves = [...getProjects(tree).values()].flatMap(
    ({ root: projectRoot }) => {
      const path = joinPathFragments(projectRoot, 'package.json');
      if (!tree.exists(path)) return [];
      const before = readJson<Manifest>(tree, path);
      for (const update of updates)
        addDependenciesToPackageJson(tree, declared(before, update), {}, path);
      const after = readJson<Manifest>(tree, path);
      return sections.flatMap((section) =>
        Object.entries(before[section] ?? {})
          .filter(([name, version]) => after[section]?.[name] !== version)
          .map(
            ([name, version]) =>
              `${path} ${name} ${version} -> ${after[section]?.[name]}`,
          ),
      );
    },
  );
  for (const move of moves)
    logger.info(`move-peers-in-project-manifests: ${move} (#5296)`);
  // nx migrate reinstalls after a migration only when the root package.json
  // changed (nx 24.0.6 execute-migration.js installDepsIfChanged,
  // readPackageJsonDeps), so node_modules lags each project this moved.
  if (moves.length > 0)
    logger.info(
      'move-peers-in-project-manifests: run npm install; nx migrate reinstalls only when the root package.json changes (#5689)',
    );
  await formatFiles(tree);
}

/** The packages of `update` that the root package.json declares at the entry's version, in either section. */
function writtenInRoot(
  root: Manifest,
  update: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(update).filter(([name, version]) =>
      sections.some((section) => root[section]?.[name] === version),
    ),
  );
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
