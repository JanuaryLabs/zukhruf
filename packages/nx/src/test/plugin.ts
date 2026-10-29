import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type CreateNodes,
  type TargetConfiguration,
  createNodesFromFiles,
  readJsonFile,
} from '@nx/devkit';
import {
  buildPackageJsonPatterns,
  buildPackageJsonWorkspacesMatcher,
} from '@nx/devkit/internal';

export interface TestOptions {
  timeout?: number;
  flags?: string[];
}

const testFile = /\.test\.(?:ts|mts|cts|js|mjs)$/;
const viteConfig = /^vite\.config\.(?:js|ts|mjs|mts|cjs|cts)$/;
const vitestConfig = /^vitest\.config\.(?:js|ts|mjs|mts|cjs|cts)$/;
const ownGlobalSetup = 'src/testing/docker-global-setup.ts';

/**
 * Gives the `test` target, a `node --test` run, to each project root that
 * owns test files and is not a Vitest project (ADR 0004). A project with the
 * tag `test:docker` also gets the global setup of `@zukhruf/testing` (ADR
 * 0005). The project roots are the roots of `./format`: a copy of its rule,
 * on the record in docs/copied-code.md.
 */
export const createNodes: CreateNodes<TestOptions> = [
  '{package.json,**/package.json,project.json,**/project.json,**/*.test.{ts,mts,cts,js,mjs},**/{vite,vitest}.config.{js,ts,mjs,mts,cjs,cts}}',
  async (files, options, context) => {
    // The defaults of ADR 0004: 60 s is the time limit of zukhruf and
    // deepagents, and no repo adds a flag for each project.
    const { timeout = 60_000, flags = [] } = options ?? {};
    const configFiles = files.filter((file) =>
      ['package.json', 'project.json'].includes(basename(file)),
    );
    const projectJsonRoots = new Set(
      configFiles
        .filter((file) => basename(file) === 'project.json')
        .map((file) => dirname(file)),
    );
    const isInWorkspaces = buildPackageJsonWorkspacesMatcher(
      buildPackageJsonPatterns(context.workspaceRoot, (file: string) =>
        readJsonFile(join(context.workspaceRoot, file)),
      ),
    );
    const rootFiles = configFiles.filter((file) =>
      basename(file) === 'project.json'
        ? true
        : !projectJsonRoots.has(dirname(file)) && isInWorkspaces(file),
    );
    const roots = new Set(rootFiles.map((file) => dirname(file)));
    const owned = new Map<string, string[]>();
    for (const file of files.filter((file) => testFile.test(file))) {
      const root = nearestRoot(roots, dirname(file));
      if (root !== undefined && root !== '.') {
        owned.set(root, [...(owned.get(root) ?? []), relative(root, file)]);
      }
    }
    const vitestRoots = new Set(
      files
        .filter((file) => vitestConfig.test(basename(file)))
        .map((file) => dirname(file)),
    );
    const viteConfigs = new Map(
      files
        .filter((file) => viteConfig.test(basename(file)))
        .map((file) => [dirname(file), file]),
    );
    return createNodesFromFiles(
      async (file) => {
        const root = dirname(file);
        const tests = owned.get(root);
        if (
          tests === undefined ||
          vitestRoots.has(root) ||
          (await hasViteTest(context.workspaceRoot, viteConfigs.get(root)))
        ) {
          return {};
        }
        const docker = tags(
          context.workspaceRoot,
          root,
          new Set(configFiles),
        ).includes('test:docker');
        const command = [
          'node --test --no-warnings',
          `--test-timeout=${timeout}`,
          ...new Set([
            ...flags,
            ...(docker
              ? [
                  `--test-global-setup=${globalSetup(context.workspaceRoot, root)}`,
                  '--test-force-exit',
                ]
              : []),
          ]),
          '--test-reporter=spec --test-reporter-destination=stdout',
          '--test-reporter=junit --test-reporter-destination=test-results.xml',
          '{args}',
        ].join(' ');
        const test: TargetConfiguration = {
          executor: 'nx:run-commands',
          options: { command, cwd: '{projectRoot}', args: selection(tests) },
          outputs: ['{projectRoot}/test-results.xml'],
          cache: false,
          dependsOn: ['^build'],
        };
        return { projects: { [root]: { targets: { test } } } };
      },
      rootFiles,
      options,
      context,
    );
  },
];

function nearestRoot(roots: Set<string>, folder: string): string | undefined {
  if (roots.has(folder)) {
    return folder;
  }
  return folder === '.' ? undefined : nearestRoot(roots, dirname(folder));
}

// One glob for each top-level folder with test files, and one glob with no
// `**` for the test files directly in the root (ADR 0004).
function selection(tests: string[]) {
  const extensions = new Map<string, Set<string>>();
  for (const test of tests) {
    const slash = test.indexOf('/');
    const folder = slash === -1 ? '' : test.slice(0, slash);
    extensions.set(
      folder,
      (extensions.get(folder) ?? new Set()).add(extname(test).slice(1)),
    );
  }
  return [...extensions]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, found]) => {
      const extension =
        found.size === 1
          ? [...found].join('')
          : `{${[...found].sort().join(',')}}`;
      return `"${folder === '' ? '' : `${folder}/**/`}*.test.${extension}"`;
    })
    .join(' ');
}

// The rule of `@nx/vitest`: a `vite.config.*` whose resolved config has
// `test` makes a Vitest project (`@nx/vitest/dist/src/plugins/plugin.js:
// 120-138`). Vite is loaded from the workspace, and only when a root has a
// `vite.config.*`.
async function hasViteTest(workspaceRoot: string, file: string | undefined) {
  if (file === undefined) {
    return false;
  }
  const vite: typeof import('vite') = await import(
    pathToFileURL(
      createRequire(join(workspaceRoot, 'package.json')).resolve('vite'),
    ).href
  );
  const config = await vite.resolveConfig(
    { configFile: join(workspaceRoot, file), mode: 'development' },
    'build',
  );
  return 'test' in config && Boolean(config.test);
}

function tags(
  workspaceRoot: string,
  root: string,
  configFiles: Set<string>,
): string[] {
  const projectJson = join(root, 'project.json');
  const packageJson = join(root, 'package.json');
  return [
    ...(configFiles.has(projectJson)
      ? (readJsonFile<{ tags?: string[] }>(join(workspaceRoot, projectJson))
          .tags ?? [])
      : []),
    ...(configFiles.has(packageJson)
      ? (readJsonFile<{ nx?: { tags?: string[] } }>(
          join(workspaceRoot, packageJson),
        ).nx?.tags ?? [])
      : []),
  ];
}

// The project's own global setup wins; else the one of `@zukhruf/testing`,
// resolved from the project root with the default conditions and written
// relative to the `cwd` of the target (ADR 0005). Node reads the value as a
// path, so a package name does not work.
function globalSetup(workspaceRoot: string, root: string) {
  const projectRoot = join(workspaceRoot, root);
  if (existsSync(join(projectRoot, ownGlobalSetup))) {
    return ownGlobalSetup;
  }
  return relative(
    projectRoot,
    createRequire(join(projectRoot, 'package.json')).resolve(
      '@zukhruf/testing/docker-global-setup',
    ),
  );
}
