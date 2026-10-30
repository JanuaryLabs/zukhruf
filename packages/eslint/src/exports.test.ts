import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { basename, dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isRecord } from './unknown-values.ts';

// A lint input of { externalDependencies: ['@zukhruf/eslint'] } hashes only
// the packages that npm's lockfile links to @zukhruf/eslint, and npm links only
// these fields. A package that an export loads outside them changes the lint
// result without changing the hash.
const EDGE_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

interface Load {
  readonly url: string;
  readonly parentURL: string | null;
}

// The child records loads, not resolutions: @nx/eslint-plugin resolves
// prettier as a presence probe for configs that this package never builds.
// require() behind lazy getters (Nx's flat configs) goes through the same hooks.
const recorder = `
import { registerHooks } from 'node:module';
const parents = new Map();
const loads = new Map();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!parents.has(result.url)) parents.set(result.url, context.parentURL ?? null);
    return result;
  },
  load(url, context, nextLoad) {
    if (!loads.has(url)) loads.set(url, parents.get(url) ?? null);
    return nextLoad(url, context);
  },
});
await import(process.argv[1]);
process.stdout.write(
  JSON.stringify([...loads].map(([url, parentURL]) => ({ url, parentURL }))),
);
`;

function loadsOf(specifier: string): Load[] {
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', recorder, import.meta.resolve(specifier)],
    // ESLint's module graph prints past spawnSync's 1 MiB default.
    { encoding: 'utf8', maxBuffer: Infinity },
  );
  if (run.status !== 0) {
    throw new Error(`import(${specifier}) failed:\n${run.stderr}`, {
      cause: run.error,
    });
  }
  const loads: unknown = JSON.parse(run.stdout);
  if (!Array.isArray(loads)) throw new Error('The child printed no loads.');
  return loads.filter(isRecord).map((load) => ({
    url: String(load['url']),
    parentURL: typeof load['parentURL'] === 'string' ? load['parentURL'] : null,
  }));
}

function readManifest(folder: string): Record<string, unknown> {
  const manifest: unknown = JSON.parse(
    readFileSync(join(folder, 'package.json'), 'utf8'),
  );
  if (!isRecord(manifest)) throw new Error(`${folder}: no manifest`);
  return manifest;
}

// The nearest package.json with a name: a nested { "type": "module" } file
// (dist/esm/package.json) marks a format, not a package. Nx loads its native
// addon from a copy in the temp folder, which lies in no package; the original
// is in @nx/nx-<platform>, an optional dependency of nx.
function packageFolderOf(url: string): string | null {
  let manifestPath = findPackageJSON(url);
  while (
    manifestPath !== undefined &&
    basename(manifestPath) === 'package.json'
  ) {
    const folder = dirname(manifestPath);
    if (typeof readManifest(folder)['name'] === 'string') {
      return realpathSync(folder);
    }
    manifestPath = findPackageJSON('..', manifestPath);
  }
  return null;
}

function nameOf(folder: string | null): string {
  return folder === null ? 'no package' : String(readManifest(folder)['name']);
}

// Node's node_modules lookup from the folder of the package that declares the
// edge; a declared optional peer that is not installed has no folder.
function installedFolder(name: string, from: string): string | null {
  for (let folder = from; ; folder = dirname(folder)) {
    const candidate = join(folder, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    if (dirname(folder) === folder) return null;
  }
}

function declaredClosure(root: string): Set<string> {
  const closure = new Set([root]);
  for (const folder of closure) {
    const manifest = readManifest(folder);
    for (const field of EDGE_FIELDS) {
      const edges = manifest[field];
      if (!isRecord(edges)) continue;
      for (const name of Object.keys(edges)) {
        const target = installedFolder(name, folder);
        if (target !== null) closure.add(target);
      }
    }
  }
  return closure;
}

const packageRoot = packageFolderOf(import.meta.resolve('@zukhruf/eslint'));
if (packageRoot === null)
  throw new Error('@zukhruf/eslint has no package.json');

const exportsMap = readManifest(packageRoot)['exports'];
if (!isRecord(exportsMap)) throw new Error('@zukhruf/eslint has no exports');
const specifiers = Object.keys(exportsMap)
  .filter((subpath) => subpath !== './package.json')
  .map((subpath) => posix.join('@zukhruf/eslint', subpath));

for (const specifier of specifiers) {
  test(`${specifier} loads only packages that @zukhruf/eslint reaches over declared edges`, () => {
    // Arrange
    const closure = declaredClosure(packageRoot);

    // Act
    const loads = loadsOf(specifier);

    // Assert
    const undeclared = new Map<string, string>();
    for (const { url, parentURL } of loads) {
      if (!url.startsWith('file:')) continue;
      const folder = packageFolderOf(url);
      if (folder === null || closure.has(folder)) continue;
      const loader = parentURL === null ? null : packageFolderOf(parentURL);
      if (loader === folder || undeclared.has(folder)) continue;
      undeclared.set(
        folder,
        `${nameOf(folder)} (loaded by ${parentURL === null ? 'the entry' : nameOf(loader)})`,
      );
    }
    assert.ok(loads.length > 0, `${specifier} loaded no modules`);
    assert.deepEqual([...undeclared.values()], []);
  });
}
