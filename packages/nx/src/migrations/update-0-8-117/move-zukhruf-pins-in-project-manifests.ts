import { readFileSync } from 'node:fs';

import {
  type Tree,
  formatFiles,
  getProjects,
  joinPathFragments,
  logger,
  readJson,
} from '@nx/devkit';
import { satisfies, validRange } from 'semver';

import { updateJsonIfChanged } from '../workspace.ts';

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const name = 'move-zukhruf-pins-in-project-manifests';

/** An exact, `^` or `~` pin of one version. nx migrate writes the exact form. */
const PIN = /^(?<style>[\^~]?)(?<version>\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

/** The @zukhruf packages that `nx migrate @zukhruf/nx` moves with it: `packageGroup` of this package. */
function packageGroup(): ReadonlySet<string> {
  const manifest: { 'nx-migrations': { packageGroup: string[] } } = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
  );
  return new Set(manifest['nx-migrations'].packageGroup);
}

/**
 * #5688: `nx migrate @zukhruf/nx@<version>` moves `packageGroup` in the root
 * package.json only (nx 24.0.6 migrate.js updatePackageJson, lines 1461-1497,
 * which reads and writes `<root>/package.json` alone), so each project's
 * package.json kept its @zukhruf pins and npm installed a second copy (Meddit
 * at 0.8.116: @zukhruf/testing 0.8.116 at the root and 0.8.96 in
 * packages/evidence-retrieval). Each package of `packageGroup` that a project
 * pins in dependencies or devDependencies moves to the version nx migrate
 * wrote for @zukhruf/nx in the root, in the style of its pin. A peer range is
 * the contract of a published package, so it stays, and is logged when it
 * excludes that version.
 */
export default async function moveZukhrufPinsInProjectManifests(
  tree: Tree,
): Promise<void> {
  const root = readJson<Manifest>(tree, 'package.json');
  const rootPin =
    root.devDependencies?.['@zukhruf/nx'] ?? root.dependencies?.['@zukhruf/nx'];
  const version =
    rootPin === undefined ? undefined : PIN.exec(rootPin)?.groups?.['version'];
  if (version === undefined) {
    logger.info(
      `${name}: package.json pins @zukhruf/nx at ${rootPin}, not at one version, so no project pin moves (#5688)`,
    );
    return;
  }
  const group = packageGroup();
  for (const [, project] of getProjects(tree)) {
    const path = joinPathFragments(project.root, 'package.json');
    if (!tree.exists(path)) continue;
    updateJsonIfChanged<Manifest>(tree, path, (manifest) => {
      for (const pins of [manifest.dependencies, manifest.devDependencies]) {
        if (pins === undefined) continue;
        for (const [pkg, pin] of Object.entries(pins)) {
          const style = PIN.exec(pin)?.groups?.['style'];
          // file:, workspace: and other non-version pins have no style and stay.
          if (!group.has(pkg) || style === undefined) continue;
          const moved = `${style}${version}`;
          if (pin === moved) continue;
          pins[pkg] = moved;
          logger.info(`${name}: ${path} ${pkg} ${pin} -> ${moved} (#5688)`);
        }
      }
      for (const [pkg, range] of Object.entries(
        manifest.peerDependencies ?? {},
      ))
        if (
          group.has(pkg) &&
          validRange(range) !== null &&
          !satisfies(version, range)
        )
          logger.info(
            `${name}: ${path} peerDependencies ${pkg} ${range} excludes ${version}: widen it by hand (#5688)`,
          );
    });
  }
  await formatFiles(tree);
}
