import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { NX_JSON, buildProjectGraph } from '../testing/project-graph.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const LEFT_PAD =
  'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQ9x9KXt8ys0eo2V1lPb4fGkuVqsXHKVjTomyT2l2mnaTfZQA==';

type App = (
  | {
      /** The app's build target in project.json. */
      build: Record<string, unknown>;
    }
  | {
      /** A package.json script, which Nx turns into the build target; the app has no project.json. */
      buildScript: string;
    }
) & {
  /** The workspace packages its code imports. */
  imports?: string[];
};

interface Layout {
  /** Apps by folder name under `apps/`; each is the package `@fx/<name>`. */
  apps: Record<string, App>;
  /** nx.json `targetDefaults`. */
  targetDefaults?: Record<string, unknown>;
  greetTags?: string[];
  greetDependencies?: Record<string, string>;
  /** greet's files under `src/`, by name; by default `index.ts` imports left-pad. */
  greetSource?: Record<string, string>;
}

/**
 * A workspace of apps and two libraries: `greet` imports the npm package
 * `left-pad`, and `shout` imports nothing. Nx learns npm packages from the
 * lockfile.
 */
function workspaceFiles({
  apps,
  targetDefaults = {},
  greetTags = [],
  greetDependencies = { 'left-pad': '1.3.0' },
  greetSource = {
    'index.ts': `import leftPad from 'left-pad';\nexport const greet = () => leftPad('hi', 5);\n`,
  },
}: Layout): Record<string, string> {
  const workspaces = [
    ...Object.keys(apps).map((name) => [`apps/${name}`, `@fx/${name}`]),
    ['libs/greet', '@fx/greet'],
    ['libs/shout', '@fx/shout'],
  ];
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
      ...Object.fromEntries(
        workspaces.flatMap(([folder, name]) => [
          [folder, { name, version: '0.0.0' }],
          [`node_modules/${name}`, { resolved: folder, link: true }],
        ]),
      ),
      'node_modules/left-pad': {
        version: '1.3.0',
        resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
        integrity: LEFT_PAD,
      },
    },
  };
  const appFiles = Object.entries(apps).flatMap(([name, app]) => {
    // With no dependencies section at all, Nx lists every package it
    // detects, ignored ones included.
    const manifest = {
      name: `@fx/${name}`,
      version: '0.0.0',
      dependencies: {},
    };
    const source = (app.imports ?? ['@fx/greet'])
      .map(
        (pkg, index) =>
          `import * as m${index} from '${pkg}';\nconsole.log(m${index});\n`,
      )
      .join('');
    return 'build' in app
      ? [
          [`apps/${name}/package.json`, JSON.stringify(manifest)],
          [
            `apps/${name}/project.json`,
            JSON.stringify({
              name,
              projectType: 'application',
              targets: { build: app.build },
            }),
          ],
          [`apps/${name}/src/main.ts`, source],
        ]
      : [
          [
            `apps/${name}/package.json`,
            JSON.stringify({
              ...manifest,
              nx: { projectType: 'application' },
              scripts: { build: app.buildScript },
            }),
          ],
          [`apps/${name}/src/main.ts`, source],
        ];
  });
  return {
    'nx.json': JSON.stringify({ ...JSON.parse(NX_JSON), targetDefaults }),
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
    ...Object.fromEntries(appFiles),
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
    ...Object.fromEntries(
      Object.entries(greetSource).map(([name, source]) => [
        `libs/greet/src/${name}`,
        source,
      ]),
    ),
    'libs/shout/package.json': JSON.stringify({
      name: '@fx/shout',
      version: '0.0.0',
      exports: { '.': './src/index.ts' },
    }),
    'libs/shout/project.json': JSON.stringify({
      name: 'shout',
      projectType: 'library',
      targets: {
        build: { executor: 'nx:run-commands', options: { command: 'true' } },
      },
    }),
    'libs/shout/src/index.ts': `export const shout = (text: string) => text.toUpperCase();\n`,
  };
}

const VITE_BUILD = { executor: '@nx/vite:build' };

const esbuild = (options?: Record<string, unknown>) => ({
  executor: '@nx/esbuild:esbuild',
  ...(options ? { options } : {}),
});

test('a bundled app must declare the npm packages its workspace imports pull in, from the root and from its folder', () => {
  // Arrange
  using workspace = fixtureWorkspace(
    workspaceFiles({ apps: { web: { build: VITE_BUILD } } }),
  );
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
    workspaceFiles({ apps: { web: { build: esbuild({ bundle: false }) } } }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(workspace.root, ['apps/web/package.json']);

  // Assert
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /@fx\/greet/);
  assert.doesNotMatch(findings[0]?.message ?? '', /left-pad/);
});

test('an app declares the workspace packages its build leaves to node_modules, and the npm packages of those it inlines', () => {
  // Arrange: every app imports greet, which imports left-pad.
  const installsGreet = {
    shell: { build: { executor: 'nx:noop' } },
    external: { build: esbuild({ external: ['@fx/greet'] }) },
    'esbuild-options': {
      build: esbuild({ esbuildOptions: { external: ['@fx/greet'] } }),
    },
    'prefix-wildcard': { build: esbuild({ external: ['@fx/*'] }) },
    'suffix-wildcard': { build: esbuild({ external: ['*/greet'] }) },
  };
  const inlinesGreet = {
    vite: { build: VITE_BUILD },
    scripted: { buildScript: 'vite build' },
    'esbuild-default': { build: esbuild() },
    excluded: {
      build: esbuild({
        external: ['@fx/greet'],
        excludeFromExternal: ['@fx/greet'],
      }),
    },
    'other-suffix': { build: esbuild({ external: ['@fx/*-ui'] }) },
    'overlapping-wildcard': { build: esbuild({ external: ['@fx/gr*reet'] }) },
    'not-imported': { build: esbuild({ external: ['@fx/shout', 'left-pad'] }) },
  };
  using workspace = fixtureWorkspace(
    workspaceFiles({ apps: { ...installsGreet, ...inlinesGreet } }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(
    workspace.root,
    Object.keys({ ...installsGreet, ...inlinesGreet }).map(
      (app) => `apps/${app}/package.json`,
    ),
  );

  // Assert
  const demandedOf = (app: string) =>
    findings
      .filter(({ file }) => file === workspace.path(`apps/${app}/package.json`))
      .map(({ message }) => message)
      .join('\n');
  for (const app of Object.keys(installsGreet)) {
    assert.match(demandedOf(app), /@fx\/greet/, app);
    assert.doesNotMatch(demandedOf(app), /left-pad/, app);
  }
  for (const app of Object.keys(inlinesGreet)) {
    assert.match(demandedOf(app), /left-pad/, app);
    assert.doesNotMatch(demandedOf(app), /@fx\/greet/, app);
  }
});

test('an esbuild app takes its external list from the target defaults in nx.json', () => {
  // Arrange
  using workspace = fixtureWorkspace(
    workspaceFiles({
      apps: { api: { build: esbuild() } },
      targetDefaults: {
        '@nx/esbuild:esbuild': { options: { external: ['@fx/greet'] } },
      },
    }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(workspace.root, ['apps/api/package.json']);

  // Assert
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /@fx\/greet/);
  assert.doesNotMatch(findings[0]?.message ?? '', /left-pad/);
});

test('an app that leaves one workspace package to node_modules never declares one it inlines', () => {
  // Arrange
  using workspace = fixtureWorkspace(
    workspaceFiles({
      apps: {
        api: {
          build: esbuild({ external: ['@fx/greet'] }),
          imports: ['@fx/greet', '@fx/shout'],
        },
      },
    }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(workspace.root, ['apps/api/package.json']);

  // Assert
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /@fx\/greet/);
  assert.doesNotMatch(findings[0]?.message ?? '', /@fx\/shout/);
});

test('a manifest is not checked before Nx caches a project graph, as on a fresh clone', () => {
  // Arrange: no buildProjectGraph.
  using workspace = fixtureWorkspace(
    workspaceFiles({ apps: { web: { build: VITE_BUILD } } }),
  );

  // Act
  const findings = lint(workspace.root, ['apps/web/package.json']);

  // Assert
  assert.deepEqual(findings, []);
});

test('an island manifest is reported once, by island/dependency-checks', () => {
  // Arrange: greet becomes an island and no longer declares left-pad.
  using workspace = fixtureWorkspace(
    workspaceFiles({
      apps: { web: { build: VITE_BUILD } },
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

for (const testFile of [
  'index.test.ts',
  'index.test.mjs',
  'index.test.js',
  'index.test.cjs',
  'index.spec.jsx',
]) {
  test(`the imports of a test file named ${testFile} are not dependencies of the package`, () => {
    // Arrange: greet ships nothing that imports left-pad; only its test does.
    using workspace = fixtureWorkspace(
      workspaceFiles({
        apps: { web: { build: VITE_BUILD } },
        greetTags: ['layer:island'],
        greetDependencies: {},
        greetSource: {
          'index.ts': `export const greet = () => 'hi';\n`,
          [testFile]: `import leftPad from 'left-pad';\nconsole.log(leftPad('hi', 5));\n`,
        },
      }),
    );
    buildProjectGraph(workspace.root);

    // Act
    const findings = lint(workspace.root, ['libs/greet/package.json']);

    // Assert
    assert.deepEqual(findings, []);
  });
}

test('the imports of a JavaScript test file are not dependencies of a package that is not an island', () => {
  // Arrange
  using workspace = fixtureWorkspace(
    workspaceFiles({
      apps: { web: { build: VITE_BUILD } },
      greetDependencies: {},
      greetSource: {
        'index.ts': `export const greet = () => 'hi';\n`,
        'index.test.mjs': `import leftPad from 'left-pad';\nconsole.log(leftPad('hi', 5));\n`,
      },
    }),
  );
  buildProjectGraph(workspace.root);

  // Act
  const findings = lint(workspace.root, ['libs/greet/package.json']);

  // Assert
  assert.deepEqual(findings, []);
});
