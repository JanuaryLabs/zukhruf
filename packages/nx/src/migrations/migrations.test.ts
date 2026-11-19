import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { readJsonFile } from '@nx/devkit';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const workspaceRoot = resolve(packageRoot, '..', '..');

interface Manifest {
  name?: string;
  private?: boolean;
  'nx-migrations'?: { migrations: string; packageGroup: string[] };
  files?: string[];
}

interface Migrations {
  generators: Record<string, { version: string; implementation: string }>;
}

test('nx migrate moves every published @zukhruf package with @zukhruf/nx', () => {
  // Nx tags each package that is not private npm:public, and nx release
  // publishes that group at one version (nx.json release.projects).
  const paths = execFileSync('git', ['ls-files', 'packages/**/package.json'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  const published = paths
    .map((path) => readJsonFile<Manifest>(join(workspaceRoot, path)))
    .filter(
      (manifest) =>
        manifest.private !== true &&
        manifest.name?.startsWith('@zukhruf/') === true &&
        manifest.name !== '@zukhruf/nx',
    )
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
