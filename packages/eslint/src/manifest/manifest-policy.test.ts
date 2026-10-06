import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { manifestPolicy } from './manifest-policy.ts';
import { projectShape } from './project-shape.ts';

const application = (build?: Record<string, unknown>) =>
  JSON.stringify({
    projectType: 'application',
    ...(build ? { targets: { build } } : {}),
  });

test('an application bundles unless its build is nx:noop or esbuild without bundling', () => {
  // Arrange
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'apps/vite/project.json': application(),
    'apps/esbuild/project.json': application({
      executor: '@nx/esbuild:esbuild',
    }),
    'apps/files/project.json': application({
      executor: '@nx/esbuild:esbuild',
      options: { bundle: false },
    }),
    'apps/shell/project.json': application({ executor: 'nx:noop' }),
    'apps/manifest-only/package.json': JSON.stringify({
      name: 'manifest-only',
      nx: { projectType: 'application' },
    }),
    'libs/greet/project.json': JSON.stringify({ projectType: 'library' }),
  });

  // Act
  const shapeOf = (folder: string) => projectShape(workspace.path(folder));

  // Assert: esbuild bundles by default; a target an Nx plugin infers is not in project.json.
  assert.equal(shapeOf('apps/vite'), 'bundled');
  assert.equal(shapeOf('apps/esbuild'), 'bundled');
  assert.equal(shapeOf('apps/files'), 'unbundled');
  assert.equal(shapeOf('apps/shell'), 'unbundled');
  assert.equal(shapeOf('apps/manifest-only'), 'bundled');
  assert.equal(shapeOf('libs/greet'), 'unbundled');
});

test('a bundled project ignores every workspace package and checks the transitive closure', () => {
  // Arrange
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'package.json': JSON.stringify({ name: 'root', private: true }),
    'apps/web/project.json': application(),
    'apps/web/package.json': JSON.stringify({ name: '@fx/web' }),
    'libs/greet/package.json': JSON.stringify({ name: '@fx/greet' }),
    'libs/deep/nested/package.json': JSON.stringify({ name: '@fx/nested' }),
    'libs/greet/dist/package.json': JSON.stringify({ name: 'built-copy' }),
    '.claude/worktrees/other/package.json': JSON.stringify({
      name: 'other-checkout',
    }),
  });

  // Act
  const policy = manifestPolicy(workspace.path('apps/web'), {
    ignoredDependencies: ['electron'],
  });

  // Assert
  assert.equal(policy.includeTransitiveDependencies, true);
  assert.deepEqual([...policy.ignoredDependencies].sort(), [
    '@fx/greet',
    '@fx/nested',
    '@fx/web',
    'electron',
  ]);
});

test('an unbundled project checks only its own imports, with the repo’s and its own extras', () => {
  // Arrange
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'libs/greet/package.json': JSON.stringify({ name: '@fx/greet' }),
    'libs/other/package.json': JSON.stringify({ name: '@fx/other' }),
  });
  const options = {
    ignoredDependencies: ['electron'],
    projects: {
      'libs/greet': { ignoredDependencies: ['google-auth-library'] },
    },
  };

  // Act
  const greet = manifestPolicy(workspace.path('libs/greet'), options);
  const other = manifestPolicy(workspace.path('libs/other'), options);

  // Assert
  assert.equal(greet.includeTransitiveDependencies, false);
  assert.deepEqual(greet.ignoredDependencies, [
    'electron',
    'google-auth-library',
  ]);
  assert.deepEqual(other.ignoredDependencies, ['electron']);
  // The shared policy survives the repo's options.
  assert.equal(greet.checkObsoleteDependencies, false);
});
