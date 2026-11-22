import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { readJsonFile } from '@nx/devkit';
import { gte, rcompare, satisfies } from 'semver';

import {
  appPackageVersions,
  rootToolVersions,
} from '../generators/versions.ts';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const workspaceRoot = resolve(packageRoot, '..', '..');

interface Manifest {
  name?: string;
  private?: boolean;
  'nx-migrations'?: { migrations: string; packageGroup: string[] };
  files?: string[];
  peerDependencies?: Record<string, string>;
}

interface PackageJsonUpdate {
  version: string;
  packages: Record<
    string,
    { version: string; alwaysAddToPackageJson: boolean }
  >;
}

interface Migrations {
  generators: Record<string, { version: string; implementation: string }>;
  // Nx reads a migrations.json with no packageJsonUpdates as one with none
  // (nx migrate.js getPackageJsonUpdatesFromMigrationConfig).
  packageJsonUpdates?: Record<string, PackageJsonUpdate>;
}

// Nx tags each package that is not private npm:public, and nx release
// publishes that group at one version (nx.json release.projects).
function publishedManifests(): (Manifest & { name: string })[] {
  const paths = execFileSync('git', ['ls-files', 'packages/**/package.json'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  return paths
    .map((path) => readJsonFile<Manifest>(join(workspaceRoot, path)))
    .filter(
      (manifest): manifest is Manifest & { name: string } =>
        manifest.private !== true &&
        manifest.name?.startsWith('@zukhruf/') === true,
    );
}

test('nx migrate moves every published @zukhruf package with @zukhruf/nx', () => {
  const published = publishedManifests()
    .filter((manifest) => manifest.name !== '@zukhruf/nx')
    .map((manifest) => manifest.name);

  const manifest = readJsonFile<Manifest>(join(packageRoot, 'package.json'));

  assert.equal(manifest['nx-migrations']?.migrations, './migrations.json');
  assert.deepEqual(
    manifest['nx-migrations']?.packageGroup,
    published.toSorted(),
  );
  assert.ok(manifest.files?.includes('migrations.json'));
});

test('each migration points at a module that exports a generator', async () => {
  const { generators } = readJsonFile<Migrations>(
    join(packageRoot, 'migrations.json'),
  );

  assert.ok(Object.keys(generators).length > 0);
  for (const [name, migration] of Object.entries(generators)) {
    assert.match(migration.version, /^\d+\.\d+\.\d+$/, name);
    const source = migration.implementation
      .replace(/^\.\/dist\//, './src/')
      .replace(/\.js$/, '.ts');
    const module: unknown = await import(join(packageRoot, source));
    assert.ok(
      typeof module === 'object' &&
        module !== null &&
        'default' in module &&
        typeof module.default === 'function',
      name,
    );
  }
});

// A release can narrow a peer range of a published package (#5061: unicorn
// ^79.0.0 to ^80.0.0 in @zukhruf/eslint 0.8.45), and npm then refuses a repo
// that has the old version (ERESOLVE). nx migrate moves a third-party package
// only through packageJsonUpdates: Nx applies each entry above the installed
// @zukhruf/nx, and only to a package that the repo declares when
// alwaysAddToPackageJson is false.
test('nx migrate moves each third-party peer that the generators install into the range of every published @zukhruf package', () => {
  const pins: Record<string, string> = {
    ...rootToolVersions,
    ...appPackageVersions,
  };
  // versions.ts pins typescript and @typescript/native as npm aliases. Nx
  // resolves a version that is not semver from the registry under the
  // package's own name (migrate.js resolveVersionForCascade), so
  // packageJsonUpdates cannot write an alias.
  const aliased = Object.entries(pins)
    .filter(([, pin]) => pin.startsWith('npm:'))
    .map(([name]) => name);
  assert.deepEqual(aliased, ['@typescript/native', 'typescript']);
  const { packageJsonUpdates } = readJsonFile<Migrations>(
    join(packageRoot, 'migrations.json'),
  );
  const updates = Object.values(packageJsonUpdates ?? {}).toSorted((a, b) =>
    rcompare(a.version, b.version),
  );

  const outOfRange = publishedManifests().flatMap((manifest) =>
    Object.entries(manifest.peerDependencies ?? {})
      .filter(
        ([peer]) =>
          !peer.startsWith('@zukhruf/') &&
          peer in pins &&
          !aliased.includes(peer),
      )
      .flatMap(([peer, range]) => {
        const newest = updates.flatMap(({ version, packages }) => {
          const target = packages[peer];
          return target ? [{ version, target: target.version }] : [];
        })[0];
        if (newest && satisfies(newest.target, range)) return [];
        const moved = newest
          ? `${newest.version} moves it to ${newest.target}`
          : 'no packageJsonUpdates entry';
        return [`${peer} ${range} of ${manifest.name}: ${moved}`];
      }),
  );

  assert.deepEqual(outOfRange, []);
  for (const { version, packages } of updates) {
    for (const [name, update] of Object.entries(packages)) {
      assert.equal(update.alwaysAddToPackageJson, false, `${version} ${name}`);
    }
  }
});

// nx migrate writes packageJsonUpdates in the root package.json only (nx
// 24.0.6 migrate.js updatePackageJson), so move-peers-in-project-manifests
// moves the same packages in each project's package.json (#5296). Nx runs a
// migration only above the installed version, so a repo gets a new entry in
// its apps only when the migration runs at or after that entry.
test("move-peers-in-project-manifests runs at or after the newest packageJsonUpdates entry, so a package that a release moves in the root moves in each project's package.json too", () => {
  const { generators, packageJsonUpdates } = readJsonFile<Migrations>(
    join(packageRoot, 'migrations.json'),
  );
  const migration = generators['move-peers-in-project-manifests'];
  const [newest] = Object.values(packageJsonUpdates ?? {})
    .map(({ version }) => version)
    .toSorted(rcompare);
  assert.ok(migration, 'migrations.json has move-peers-in-project-manifests');
  assert.ok(newest, 'migrations.json has a packageJsonUpdates entry');
  assert.ok(
    gte(migration.version, newest),
    `move-peers-in-project-manifests runs at ${migration.version}, before the packageJsonUpdates of ${newest}: move it to the release of that entry`,
  );
});
