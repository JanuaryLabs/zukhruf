import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProjectGraph, ProjectGraphProjectNode } from '@nx/devkit';

import { manifestPolicy } from './manifest-policy.ts';

const library = (name: string, root: string): ProjectGraphProjectNode => ({
  type: 'lib',
  name,
  data: { root, projectType: 'library' },
});

test('an unbundled project checks only its own imports, with the repo’s and its own extras', () => {
  // Arrange: `projects` keys are folders, not project names.
  const greet = library('greet', 'libs/greet');
  const other = library('other', 'libs/other');
  const graph: ProjectGraph = {
    nodes: { [greet.name]: greet, [other.name]: other },
    dependencies: { [greet.name]: [], [other.name]: [] },
  };
  const options = {
    ignoredDependencies: ['electron'],
    projects: {
      'libs/greet': { ignoredDependencies: ['google-auth-library'] },
    },
  };

  // Act
  const greetPolicy = manifestPolicy(graph, greet, options);
  const otherPolicy = manifestPolicy(graph, other, options);

  // Assert
  assert.equal(greetPolicy.includeTransitiveDependencies, false);
  assert.deepEqual(greetPolicy.ignoredDependencies, [
    'electron',
    'google-auth-library',
  ]);
  assert.deepEqual(otherPolicy.ignoredDependencies, ['electron']);
  // The shared policy survives the repo's options.
  assert.equal(greetPolicy.checkObsoleteDependencies, false);
});
