import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { NX_JSON, buildProjectGraph } from '../testing/project-graph.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const LEFT_PAD =
  'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQ9x9KXt8ys0eo2V1lPb4fGkuVqsXHKVjTomyT2l2mnaTfZQA==';

interface Layout {
  /** The app's build target. */
  webBuild: Record<string, unknown>;
  greetTags?: string[];
  greetDependencies?: Record<string, string>;
}

/**
 * A workspace where the app `web` imports the library `greet`, and `greet`
 * imports the npm package `left-pad`. Nx learns npm packages from the lockfile.
 */
function workspaceFiles({
  webBuild,
  greetTags = [],
  greetDependencies = { 'left-pad': '1.3.0' },
}: Layout): Record<string, string> {
  const lock = {
    name: 'fx',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'fx',
        workspaces: ['apps/*', 'libs/*'],
        dependencies: { 'left-pad': '1.3.0' },
      },
      'apps/web': { name: '@fx/web', version: '0.0.0' },
      'libs/greet': { name: '@fx/greet', version: '0.0.0' },
      'node_modules/@fx/web': { resolved: 'apps/web', link: true },
      'node_modules/@fx/greet': { resolved: 'libs/greet', link: true },
      'node_modules/left-pad': {
        version: '1.3.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: LEFT_PAD,
      },
    },
  };
  return {
    'nx.json': NX_JSON,
    'package.json': JSON.stringify({
      name: 'fx',
      private: true,
      workspaces: ['apps/*', 'libs/*'],
      dependencies: { 'left-pad': '1.3.0' },
    }),
    'package-lock.json': JSON.stringify(lock),
    'eslint.config.mjs': fixtureConfig(`{
      plugins: { island, manifest },
      extends: ['island/recommended', 'manifest/recommended'],
    }`),
    // With no dependencies section at all, Nx lists every package it detects,
    // ignored ones included.
    'apps/web/package.json': JSON.stringify({
      name: '@fx/web',
      version: '0.0.0',
      dependencies: {},
    }),
    'apps/web/project.json': JSON.stringify({
      name: 'web',
      projectType: 'application',
      targets: { build: webBuild },
    }),
    'apps/web/src/main.ts': `import { greet } from '@fx/greet';\nconsole.log(greet());\n`,
    'libs/greet/package.json': JSON.stringify({
      name: '@fx/greet',
      version: '0.0.0',
      exports: { '.': './src/index.ts' },
      dependencies: greetDependencies,
    }),
    'libs/greet/project.json': JSON.stringify({
      name: 'greet',
      projectType: 'library',
      tags: greetTags,
      targets: {
        build: { executor: 'nx:run-commands', options: { command: 'true' } },
      },
    }),
    'libs/greet/src/index.ts': `import leftPad from 'left-pad';\nexport const greet = () => leftPad('hi', 5);\n`,
  };
}

const VITE_BUILD = { executor: '@nx/vite:build' };

test('a bundled app must declare the npm packages its workspace imports pull in, from the root and from its folder', () => {
  // Arrange
  using workspace = fixtureWorkspace(workspaceFiles({ webBuild: VITE_BUILD }));
  buildProjectGraph(workspace.root);

  // Act
  const fromRoot = lint(workspace.root, ['apps/web/package.json']);
  const fromProject = lint(workspace.path('apps/web'), ['package.json']);

  // Assert: left-pad comes through greet; greet itself is inlined, so not demanded.
  for (const findings of [fromRoot, fromProject]) {
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.ruleId, 'manifest/dependency-checks');
    assert.match(findings[0]?.message ?? '', /left-pad/);
    assert.doesNotMatch(findings[0]?.message ?? '', /@fx\/greet/);
  }
});

test('an app that does not bundle declares its workspace imports, not their npm packages', () => {
  // Arrange: esbuild with bundle: false transpiles file by file.
  using workspace = fixtureWorkspace(
    workspaceFiles({
      webBuild: { executor: '@nx/esbuild:esbuild', options: { bundle: false } },
    }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(workspace.root, ['apps/web/package.json']);

  // Assert
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /@fx\/greet/);
  assert.doesNotMatch(findings[0]?.message ?? '', /left-pad/);
});

test('an island manifest is reported once, by island/dependency-checks', () => {
  // Arrange: greet becomes an island and no longer declares left-pad.
  using workspace = fixtureWorkspace(
    workspaceFiles({
      webBuild: VITE_BUILD,
      greetTags: ['layer:island'],
      greetDependencies: {},
    }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(workspace.root, ['libs/greet/package.json']);

  // Assert
  assert.deepEqual(
    findings.map(({ ruleId }) => ruleId),
    ['island/dependency-checks'],
  );
  assert.match(findings[0]?.message ?? '', /left-pad/);
});
