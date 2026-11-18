import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-generate-package-json.ts';

const ruleTester = jsonRuleTester();

const TS_SOLUTION = {
  'nx.json': '{}',
  'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
  'tsconfig.json': `{
    // the solution file: it only references the projects
    "extends": "./tsconfig.base.json",
    "files": [],
    "references": [{ "path": "./apps/api" }],
  }`,
  'tsconfig.base.json': JSON.stringify({
    compilerOptions: { composite: true, declaration: true },
  }),
};

test('generatePackageJson of an @nx/esbuild target in a TS solution workspace is reported, in options and in each configuration', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(TS_SOLUTION);
  const code = JSON.stringify({
    targets: {
      build: {
        executor: '@nx/esbuild:esbuild',
        options: { main: 'apps/api/src/main.ts', generatePackageJson: true },
        configurations: {
          development: { minify: false },
          production: { generatePackageJson: true },
        },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-generate-package-json', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('apps/api/project.json'),
        errors: [
          { messageId: 'generatePackageJson', data: { target: 'build' } },
          { messageId: 'generatePackageJson', data: { target: 'build' } },
        ],
      },
    ],
  });
});

test('generatePackageJson in the nx key of a package.json is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(TS_SOLUTION);
  const code = JSON.stringify({
    name: '@acme/api',
    nx: {
      targets: {
        build: {
          executor: '@nx/esbuild:esbuild',
          options: { generatePackageJson: true },
        },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-generate-package-json', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('apps/api/package.json'),
        errors: [
          { messageId: 'generatePackageJson', data: { target: 'build' } },
        ],
      },
    ],
  });
});

test('generatePackageJson passes where @nx/esbuild accepts it: a workspace that is not a TS solution one', async () => {
  // Arrange
  const code = JSON.stringify({
    targets: {
      build: {
        executor: '@nx/esbuild:esbuild',
        options: { generatePackageJson: true },
      },
    },
  });
  await using noWorkspaces = await fixtureWorkspace({
    ...TS_SOLUTION,
    'package.json': JSON.stringify({ name: '@acme/source' }),
  });
  await using solutionIncludesFiles = await fixtureWorkspace({
    ...TS_SOLUTION,
    'tsconfig.json': JSON.stringify({
      extends: './tsconfig.base.json',
      include: ['src'],
    }),
  });
  await using notComposite = await fixtureWorkspace({
    ...TS_SOLUTION,
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true } }),
  });
  await using noSolutionFile = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': TS_SOLUTION['package.json'],
    'tsconfig.base.json': TS_SOLUTION['tsconfig.base.json'],
  });

  // Act + Assert
  ruleTester.run('no-generate-package-json', rule, {
    valid: [
      { code, filename: noWorkspaces.path('apps/api/project.json') },
      { code, filename: solutionIncludesFiles.path('apps/api/project.json') },
      { code, filename: notComposite.path('apps/api/project.json') },
      { code, filename: noSolutionFile.path('apps/api/project.json') },
    ],
    invalid: [],
  });
});

test('a pnpm workspace with packages is a TS solution workspace too', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    ...TS_SOLUTION,
    'package.json': JSON.stringify({ name: '@acme/source' }),
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
  });
  const code = JSON.stringify({
    targets: {
      build: {
        executor: '@nx/esbuild:esbuild',
        options: { generatePackageJson: true },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-generate-package-json', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('apps/api/project.json'),
        errors: [
          { messageId: 'generatePackageJson', data: { target: 'build' } },
        ],
      },
    ],
  });
});

test('in a TS solution workspace, generatePackageJson false passes, and another executor is not checked', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace(TS_SOLUTION);
  const unset = JSON.stringify({
    targets: {
      build: {
        executor: '@nx/esbuild:esbuild',
        options: { generatePackageJson: false },
      },
    },
  });
  const webpack = JSON.stringify({
    targets: {
      build: {
        executor: '@nx/webpack:webpack',
        options: { generatePackageJson: true },
      },
    },
  });

  // Act + Assert
  ruleTester.run('no-generate-package-json', rule, {
    valid: [
      { code: unset, filename: workspace.path('apps/api/project.json') },
      { code: webpack, filename: workspace.path('apps/web/project.json') },
    ],
    invalid: [],
  });
});
