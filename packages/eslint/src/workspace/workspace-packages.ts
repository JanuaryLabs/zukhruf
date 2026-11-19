import { globSync } from 'node:fs';
import { join } from 'node:path';

import { isRecord, stringsAt } from '../unknown-values.ts';
import { readJson } from './project-manifest.ts';

// Rules run once per linted file; the files of a run share one root.
const namesByRoot = new Map<string, ReadonlySet<string>>();

function packageName(manifest: unknown): string[] {
  const name = isRecord(manifest) ? manifest['name'] : undefined;
  return typeof name === 'string' ? [name] : [];
}

function readNames(root: string): ReadonlySet<string> {
  const manifest = readJson(join(root, 'package.json'));
  const members = stringsAt(manifest, 'workspaces').flatMap((glob) =>
    globSync(`${glob}/package.json`, { cwd: root }),
  );
  return new Set(
    members.flatMap((path) => packageName(readJson(join(root, path)))),
  );
}

/**
 * The npm names of the packages of the workspace at `root`, each package that
 * a `workspaces` glob of the root package.json matches, read from the
 * manifests rather than from Nx's cached project graph, which does not exist
 * on a fresh clone.
 */
export function workspacePackageNames(root: string): ReadonlySet<string> {
  const known = namesByRoot.get(root);
  if (known !== undefined) return known;
  const names = readNames(root);
  namesByRoot.set(root, names);
  return names;
}
