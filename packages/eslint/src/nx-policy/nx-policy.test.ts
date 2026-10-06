import assert from 'node:assert/strict';
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
  assert.ok(
    policy.ignoredFiles.includes(
      '{projectRoot}/**/*.{test,spec}.{ts,tsx,mts,cts}',
    ),
    'Test files must stay ignored when a project adds its own files',
  );
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
