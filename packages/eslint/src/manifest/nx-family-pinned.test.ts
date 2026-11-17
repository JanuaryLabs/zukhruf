import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './nx-family-pinned.ts';

const ruleTester = jsonRuleTester();

test('a workspace root that gives an @nx/* package a caret range beside an exact nx is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    devDependencies: { '@nx/react': '^22.6.2', nx: '22.6.2' },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('package.json'),
        errors: [
          {
            messageId: 'notExact',
            data: { name: '@nx/react', version: '^22.6.2', nx: '22.6.2' },
          },
        ],
      },
    ],
  });
});

test('a workspace root that pins an @nx/* package to a version other than nx is reported, in dependencies too', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    dependencies: { '@nx/js': '22.6.3' },
    devDependencies: { '@nx/vite': '22.6.1', nx: '22.6.2' },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('package.json'),
        errors: [
          {
            messageId: 'notEqual',
            data: { name: '@nx/js', version: '22.6.3', nx: '22.6.2' },
          },
          {
            messageId: 'notEqual',
            data: { name: '@nx/vite', version: '22.6.1', nx: '22.6.2' },
          },
        ],
      },
    ],
  });
});

test('a workspace root that gives nx itself a range is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({ devDependencies: { nx: '~22.6.2' } });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('package.json'),
        errors: [
          {
            messageId: 'notExact',
            data: { name: 'nx', version: '~22.6.2', nx: '~22.6.2' },
          },
        ],
      },
    ],
  });
});

test('a workspace root that gives @nx/* packages a range of any other shape is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    devDependencies: {
      nx: '22.6.2',
      '@nx/js': '>=22.6.2',
      '@nx/vite': '*',
      '@nx/react': 'latest',
      '@nx/web': '22.x',
    },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('package.json'),
        errors: [
          {
            messageId: 'notExact',
            data: { name: '@nx/js', version: '>=22.6.2', nx: '22.6.2' },
          },
          {
            messageId: 'notExact',
            data: { name: '@nx/vite', version: '*', nx: '22.6.2' },
          },
          {
            messageId: 'notExact',
            data: { name: '@nx/react', version: 'latest', nx: '22.6.2' },
          },
          {
            messageId: 'notExact',
            data: { name: '@nx/web', version: '22.x', nx: '22.6.2' },
          },
        ],
      },
    ],
  });
});

test('a workspace package that lists nx or an @nx/* package in dependencies is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    dependencies: { nx: '21.2.3', '@nx/devkit': '24.0.1' },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('tools/tailwind-sync-plugin/package.json'),
        errors: [
          {
            messageId: 'notPeer',
            data: { section: 'dependencies', name: 'nx' },
          },
          {
            messageId: 'notPeer',
            data: { section: 'dependencies', name: '@nx/devkit' },
          },
        ],
      },
    ],
  });
});

test('a workspace package that lists an @nx/* package in devDependencies is reported, even at the root version', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({ devDependencies: { '@nx/devkit': '22.6.2' } });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('packages/plugin/package.json'),
        errors: [
          {
            messageId: 'notPeer',
            data: { section: 'devDependencies', name: '@nx/devkit' },
          },
        ],
      },
    ],
  });
});

test('a workspace package that lists an @nx/* package in optionalDependencies is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({ optionalDependencies: { '@nx/js': '22.6.2' } });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('packages/plugin/package.json'),
        errors: [
          {
            messageId: 'notPeer',
            data: { section: 'optionalDependencies', name: '@nx/js' },
          },
        ],
      },
    ],
  });
});

test('a workspace package that names nx in peerDependencies with a range passes', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    peerDependencies: { nx: '>=23.2.1 <25.0.0', '@nx/devkit': '>=21.0.0' },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [{ code, filename: workspace.path('packages/nx/package.json') }],
    invalid: [],
  });
});

test('a workspace root that pins nx in dependencies and @nx/* packages in devDependencies to the same exact version passes', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    dependencies: { nx: '23.2.1' },
    devDependencies: { '@nx/js': '23.2.1', '@nx/eslint-plugin': '23.2.1' },
    peerDependencies: { '@nx/devkit': '>=21.0.0' },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [{ code, filename: workspace.path('package.json') }],
    invalid: [],
  });
});

test('a workspace root that pins nx and @nx/* packages to the same prerelease passes', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    devDependencies: { nx: '23.0.0-beta.3', '@nx/js': '23.0.0-beta.3' },
  });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [{ code, filename: workspace.path('package.json') }],
    invalid: [],
  });
});

test('a manifest outside any workspace is checked as a root, so its own nx devDependency passes', () => {
  // Arrange
  const code = JSON.stringify({ devDependencies: { nx: '23.2.1' } });

  // Act + Assert
  ruleTester.run('nx-family-pinned', rule, {
    valid: [
      { code, filename: join(tmpdir(), 'not-a-workspace', 'package.json') },
    ],
    invalid: [],
  });
});
