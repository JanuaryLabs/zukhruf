import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Lockfile } from './lockfile.ts';

test('the projects of a lockfile are the root, the workspaces and the folders of the repo that a file: dependency links to, without a package in a node_modules folder or a folder outside the repo', () => {
  // Arrange
  const text = JSON.stringify({
    name: 'probe',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'probe', workspaces: ['packages/*'] },
      'packages/a': { name: '@probe/a', version: '0.0.0' },
      'tools/vendored': { name: 'vendored', version: '1.0.0' },
      'node_modules/@probe/a': { resolved: 'packages/a', link: true },
      'node_modules/vendored': { resolved: 'tools/vendored', link: true },
      'node_modules/left-pad': { version: '1.3.0' },
      'packages/a/node_modules/left-pad': { version: '1.0.0' },
      '../shared': { name: 'shared', version: '2.0.0' },
      'node_modules/shared': { resolved: '../shared', link: true },
      '../shared/node_modules/right-pad': { version: '1.0.0' },
    },
  });

  // Act
  const projects = Lockfile.parse(text).projects();

  // Assert
  assert.deepEqual(projects, ['', 'packages/a', 'tools/vendored']);
});

test('a lockfile without "packages", as npm 6 writes it, is refused with the npm version that writes one', () => {
  // Arrange
  const text = JSON.stringify({
    name: 'probe',
    lockfileVersion: 1,
    dependencies: { 'left-pad': { version: '1.3.0' } },
  });

  // Act
  const parse = () => Lockfile.parse(text);

  // Assert
  assert.throws(parse, {
    name: 'TypeError',
    message: /no "packages"; npm 7 or later writes it/,
  });
});
