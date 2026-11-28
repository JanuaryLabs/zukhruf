import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { NX_JSON, buildProjectGraph } from '../testing/project-graph.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const runs = (command: string, extra: Record<string, unknown> = {}) => ({
  executor: 'nx:run-commands',
  options: { command, cwd: '{projectRoot}' },
  ...extra,
});

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe(
  'no-missing-dependency-build',
  { concurrency: availableParallelism() },
  () => {
    test('a target that runs a file importing a built workspace package must depend on its build', async () => {
      // Arrange: @fx/greet loads from dist, which its build writes; @fx/shout
      // loads from source and imports @fx/greet.
      await using workspace = await fixtureWorkspace({
        'nx.json': JSON.stringify({
          ...JSON.parse(NX_JSON),
          targetDefaults: { 'seed-defaults': { dependsOn: ['^build'] } },
        }),
        'package.json': JSON.stringify({
          name: 'fx',
          private: true,
          workspaces: ['apps/*', 'libs/*'],
        }),
        'eslint.config.mjs': fixtureConfig(`{
      plugins: { zukhruf },
      extends: ['zukhruf/nx-project-json'],
    }`),
        'libs/greet/package.json': JSON.stringify({
          name: '@fx/greet',
          version: '0.0.0',
          type: 'module',
          exports: {
            '.': { development: './src/index.ts', default: './dist/index.js' },
          },
        }),
        'libs/greet/project.json': JSON.stringify({
          name: 'greet',
          targets: {
            build: {
              executor: 'nx:run-commands',
              outputs: ['{projectRoot}/dist'],
              options: { command: 'true' },
            },
          },
        }),
        'libs/greet/src/index.ts': `export type Greet = () => string;\nexport const greet: Greet = () => 'hi';\n`,
        // No exports: Node loads main.
        'libs/plain/package.json': JSON.stringify({
          name: '@fx/plain',
          version: '0.0.0',
          main: './dist/index.js',
        }),
        'libs/plain/project.json': JSON.stringify({
          name: 'plain',
          targets: {
            build: {
              executor: 'nx:run-commands',
              outputs: ['{projectRoot}/dist'],
              options: { command: 'true' },
            },
          },
        }),
        'libs/shout/package.json': JSON.stringify({
          name: '@fx/shout',
          version: '0.0.0',
          type: 'module',
          exports: { '.': './src/index.ts' },
          dependencies: { '@fx/greet': '*' },
        }),
        'libs/shout/project.json': JSON.stringify({ name: 'shout' }),
        'libs/shout/src/index.ts': `import { greet } from '@fx/greet';\nexport const shout = () => greet().toUpperCase();\n`,
        'apps/cli/package.json': JSON.stringify({
          name: '@fx/cli',
          version: '0.0.0',
          type: 'module',
          dependencies: { '@fx/greet': '*', '@fx/shout': '*' },
          scripts: { seed: 'node scripts/main.ts' },
        }),
        'apps/cli/project.json': JSON.stringify({
          name: 'cli',
          targets: {
            // The incident: the import of the built package is one file away.
            seed: runs('node scripts/main.ts'),
            script: { executor: 'nx:run-script', options: { script: 'seed' } },
            shout: runs('node scripts/via-shout.ts'),
            'test-glob': runs('node --test "scripts/tests/*.test.ts"'),
            'with-deps': runs('node scripts/main.ts', {
              dependsOn: ['^build'],
            }),
            'seed-defaults': runs('node scripts/main.ts'),
            build: { executor: 'nx:noop', dependsOn: ['^build'] },
            'through-build': runs('node scripts/main.ts', {
              dependsOn: ['build'],
            }),
            development: runs('node --conditions=development scripts/main.ts'),
            typed: runs('node scripts/typed.ts'),
            reexport: runs('node scripts/reexport.ts'),
            'type-reexport': runs('node scripts/type-reexport.ts'),
            lazy: runs('node scripts/lazy.ts'),
            inline: runs(
              `node -e "import('@fx/greet')" scripts/main.ts && echo done`,
            ),
            broken: runs('node scripts/broken.ts'),
            missing: runs('node scripts/missing.ts'),
            plain: runs('node scripts/plain.mjs'),
          },
        }),
        'apps/cli/scripts/main.ts': `import { run } from './run.ts';\nrun();\n`,
        // A cycle back to main.ts, and an npm package that is not in the workspace.
        'apps/cli/scripts/run.ts': `import './main.ts';\nimport 'left-pad';\nimport { greet } from '@fx/greet';\nexport const run = () => console.log(greet());\n`,
        'apps/cli/scripts/broken.ts': `import { greet } from '@fx/greet';\nexport const = ;\n`,
        'apps/cli/scripts/plain.mjs': `import '@fx/plain';\n`,
        'apps/cli/scripts/via-shout.ts': `import { shout } from '@fx/shout';\nconsole.log(shout());\n`,
        'apps/cli/scripts/typed.ts': `import type { Greet } from '@fx/greet';\nexport const named: Greet = () => 'typed';\n`,
        'apps/cli/scripts/reexport.ts': `export { greet } from '@fx/greet';\n`,
        'apps/cli/scripts/type-reexport.ts': `export type { Greet } from '@fx/greet';\n`,
        'apps/cli/scripts/lazy.ts': `const { greet } = await import('@fx/greet');\ngreet();\n`,
        'apps/cli/scripts/tests/greet.test.ts': `import { greet } from '@fx/greet';\ngreet();\n`,
      });
      await buildProjectGraph(workspace.root);

      // Act
      const findings = (
        await lint(workspace.root, ['apps/cli/project.json'])
      ).filter(
        ({ ruleId }) => ruleId === 'zukhruf/no-missing-dependency-build',
      );

      // Assert
      const reported = findings.map(
        ({ message }) => /^Target "([^"]+)"/.exec(message)?.[1],
      );
      assert.deepEqual(reported.toSorted(), [
        'lazy',
        'plain',
        'reexport',
        'script',
        'seed',
        'shout',
        'test-glob',
      ]);
      assert.equal(
        findings.find(({ message }) => message.startsWith('Target "seed"'))
          ?.message,
        'Target "seed" runs apps/cli/scripts/main.ts, which imports @fx/greet. Node loads libs/greet/dist/index.js, which greet:build writes. Add "^build" to dependsOn, or a clean checkout fails with ERR_MODULE_NOT_FOUND.',
      );
    });

    test('without the graph that nx caches, as on a fresh clone, the rule checks nothing', async () => {
      // Arrange: the incident shape, and no project graph built.
      await using workspace = await fixtureWorkspace({
        'nx.json': NX_JSON,
        'package.json': JSON.stringify({
          name: 'fx',
          private: true,
          workspaces: ['apps/*', 'libs/*'],
        }),
        'eslint.config.mjs': fixtureConfig(`{
      plugins: { zukhruf },
      extends: ['zukhruf/nx-project-json'],
    }`),
        'libs/greet/package.json': JSON.stringify({
          name: '@fx/greet',
          version: '0.0.0',
          type: 'module',
          exports: { '.': './dist/index.js' },
        }),
        'libs/greet/project.json': JSON.stringify({
          name: 'greet',
          targets: {
            build: {
              executor: 'nx:run-commands',
              outputs: ['{projectRoot}/dist'],
              options: { command: 'true' },
            },
          },
        }),
        'apps/cli/package.json': JSON.stringify({
          name: '@fx/cli',
          version: '0.0.0',
          type: 'module',
        }),
        'apps/cli/project.json': JSON.stringify({
          name: 'cli',
          targets: { seed: runs('node scripts/main.ts') },
        }),
        'apps/cli/scripts/main.ts': `import { greet } from '@fx/greet';\ngreet();\n`,
      });

      // Act
      const findings = await lint(workspace.root, ['apps/cli/project.json']);

      // Assert
      assert.deepEqual(findings, []);
    });
  },
);
