import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';

import { dependencyPolicy } from './dependency-policy.ts';
import { islandConstraint } from './island-constraint.ts';
import { moduleBoundaries } from './module-boundaries.ts';

test('dependencyPolicy appends a project’s entries to the full policy instead of replacing it', () => {
  const policy = dependencyPolicy({
    ignoredFiles: ['{projectRoot}/prisma.config.ts'],
    ignoredDependencies: ['electron'],
  });

  assert.equal(policy.checkObsoleteDependencies, false);
  assert.equal(policy.includeTransitiveDependencies, false);
  const ignored = (path: string) =>
    policy.ignoredFiles.some((glob) =>
      matchesGlob(path, glob.replace('{projectRoot}', 'libs/greet')),
    );
  for (const extension of [
    'ts',
    'tsx',
    'cts',
    'mts',
    'js',
    'jsx',
    'cjs',
    'mjs',
  ]) {
    for (const kind of ['test', 'spec']) {
      const testFile = `libs/greet/src/deep/x.${kind}.${extension}`;
      assert.ok(
        ignored(testFile),
        `Test files must stay ignored when a project adds its own files: ${testFile}`,
      );
    }
  }
  for (const shipped of ['libs/greet/src/x.ts', 'libs/greet/src/x.mjs']) {
    assert.ok(!ignored(shipped), `Shipped code must stay checked: ${shipped}`);
  }
  assert.ok(policy.ignoredFiles.includes('{projectRoot}/prisma.config.ts'));
  assert.deepEqual(policy.ignoredDependencies, ['electron']);
});

test('dependencyPolicy lets a project change a switch it names', () => {
  const policy = dependencyPolicy({ includeTransitiveDependencies: true });

  assert.equal(policy.includeTransitiveDependencies, true);
  assert.equal(policy.checkMissingDependencies, true);
});

test('moduleBoundaries keeps the shared allow entry and constraint beside the repo’s own', () => {
  const options = moduleBoundaries({
    allow: ['@workspace/legacy'],
    depConstraints: [islandConstraint(['hono'])],
  });

  assert.equal(options.enforceBuildableLibDependency, true);
  assert.equal(options.allow.length, 2);
  assert.ok(options.allow.includes('@workspace/legacy'));
  assert.deepEqual(options.depConstraints, [
    { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
    {
      sourceTag: 'layer:island',
      onlyDependOnLibsWithTags: ['layer:island'],
      bannedExternalImports: ['hono'],
    },
  ]);
});
