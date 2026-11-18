import {
  type GeneratorCallback,
  type NxJsonConfiguration,
  type Tree,
  formatFiles,
  installPackagesTask,
  runTasksInSerial,
  updateJson,
  writeJson,
} from '@nx/devkit';

import { addLines } from '../add-lines.ts';
import { appDirectory, projectNameOf } from '../app-directory.ts';
import initGenerator from '../init/generator.ts';
import {
  mergeGeneratorDefaults,
  unique,
  updateTargetDefault,
} from '../init/nx-json.ts';
import { nxPlugin } from '../nx-plugin.ts';
import {
  fseventsScript,
  rootDependencyNames,
  settleRootDependencies,
} from '../root-dependencies.ts';
import { appPackageVersions as versions } from '../versions.ts';
import { workspaceScope } from '../workspace-scope.ts';
import {
  appTestTs,
  appTs,
  clientManifest,
  clientTsconfig,
  dockerfile,
  dockerignore,
  envExample,
  envTs,
  eslintConfig,
  healthzRouteTs,
  loggingTs,
  sdkItConfig,
  serverTs,
  startupTs,
} from './files.ts';

export interface NodeAppOptions {
  /** The project root, for example `apps/backend`. */
  directory: string;
  /** The port of the server in development, in `.env.example`, portless and `EXPOSE`. */
  port?: number;
}

/** The package.json of a project whose targets are in its `nx` key. */
interface ProjectPackageJson {
  name?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  nx?: { projectType?: string; targets?: Record<string, unknown> };
}

export const createRequireBanner =
  "import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(import.meta.url);";

const tsSolutionTsconfigInput = {
  json: '{workspaceRoot}/tsconfig.json',
  fields: ['extends', 'files', 'include'],
};

/**
 * A Hono backend on @hono/node-server: evlog, terminus, a zod env, one ESM
 * esbuild bundle, a Dockerfile whose image reports its commit at /api/healthz,
 * and a generated sdk-it client. It runs `init` first.
 */
export default async function nodeAppGenerator(
  tree: Tree,
  options: NodeAppOptions,
): Promise<GeneratorCallback> {
  const initTask = await initGenerator(tree);
  const scope = workspaceScope(tree);
  const { projectRoot, name, rootOffset } = appDirectory(options.directory);
  const port = options.port ?? 3000;
  const before = rootDependencyNames(tree);

  const { applicationGenerator } = nxPlugin('@nx/node');
  // @nx/node adds a VS Code launch configuration; the one that was there stays.
  const launchJson = tree.read('.vscode/launch.json');
  const appTask = await applicationGenerator(tree, {
    directory: projectRoot,
    framework: 'none',
    bundler: 'esbuild',
    linter: 'eslint',
    unitTestRunner: 'none',
    e2eTestRunner: 'none',
    docker: false,
    useProjectJson: false,
    addPlugin: true,
    port,
    skipFormat: true,
  });
  if (launchJson === null) {
    tree.delete('.vscode/launch.json');
  } else {
    tree.write('.vscode/launch.json', launchJson);
  }
  const projectName = projectNameOf(tree, projectRoot);

  tree.delete(`${projectRoot}/src/main.ts`);
  tree.delete(`${projectRoot}/src/assets/.gitkeep`);
  writeTsconfigs(tree, projectRoot, rootOffset);
  writeProjectPackageJson(tree, {
    projectRoot,
    name,
    projectName,
    port,
    scope,
  });
  tree.write(
    `${projectRoot}/eslint.config.mjs`,
    eslintConfig(projectRoot, rootOffset),
  );
  tree.write(`${projectRoot}/src/app.ts`, appTs);
  tree.write(`${projectRoot}/src/app.test.ts`, appTestTs);
  tree.write(`${projectRoot}/src/env.ts`, envTs(port));
  tree.write(`${projectRoot}/src/logging.ts`, loggingTs(name));
  tree.write(`${projectRoot}/src/routes/healthz.route.ts`, healthzRouteTs);
  tree.write(`${projectRoot}/src/server.ts`, serverTs);
  tree.write(`${projectRoot}/src/startup.ts`, startupTs);
  // .env.example is the generator's; .env is the developer's copy.
  tree.write(`${projectRoot}/.env.example`, envExample(port));
  if (!tree.exists(`${projectRoot}/.env`)) {
    tree.write(`${projectRoot}/.env`, envExample(port));
  }
  wireSdk(tree, { projectRoot, name, projectName, rootOffset, scope });
  tree.write(
    `${projectRoot}/Dockerfile`,
    dockerfile({ projectRoot, projectName, port }),
  );
  if (!tree.exists('.dockerignore')) {
    tree.write('.dockerignore', dockerignore);
  }
  mergeNodeNxJson(tree);

  settleRootDependencies(tree, before, {
    devDependencies: {
      '@sdk-it/cli': versions['@sdk-it/cli'],
      '@types/node': versions['@types/node'],
      esbuild: versions.esbuild,
      tslib: versions.tslib,
    },
    // @nx/js adds the swc toolchain, and nothing here runs it: esbuild
    // bundles and typescript-eslint parses.
    residue: ['@swc/cli', '@swc/core', '@swc/helpers'],
    // esbuild's postinstall puts the native binary in place of its JS
    // wrapper. @nx/node brings @parcel/watcher through @nx/jest, and it
    // builds from source only when asked, so its script does not run.
    allowScripts: {
      esbuild: true,
      '@parcel/watcher': false,
      ...fseventsScript,
    },
    // sdk-it peers on typescript ^6.0.3, and the TypeScript 6 API alias of
    // the root is 6.0.2, the last @typescript/typescript6. Each edge takes
    // the root typescript.
    overrides: {
      '@sdk-it/cli': { typescript: '$typescript' },
      '@sdk-it/hono': { typescript: '$typescript' },
    },
  });

  await formatFiles(tree);
  return runTasksInSerial(initTask, appTask, () => installPackagesTask(tree));
}

/**
 * @nx/node writes the app tsconfigs with `module: nodenext` and dist as the
 * outDir. The app keeps the workspace base (bundler resolution) and keeps dist
 * free of type-check output: typecheck writes to out-tsc.
 */
function writeTsconfigs(
  tree: Tree,
  projectRoot: string,
  rootOffset: string,
): void {
  const base = `${rootOffset}tsconfig.base.json`;
  writeJson(tree, `${projectRoot}/tsconfig.json`, {
    extends: base,
    files: [],
    include: [],
    references: [
      { path: './tsconfig.app.json' },
      { path: './tsconfig.test.json' },
    ],
  });
  writeJson(tree, `${projectRoot}/tsconfig.app.json`, {
    extends: base,
    compilerOptions: {
      outDir: 'out-tsc',
      rootDir: 'src',
      tsBuildInfoFile: 'out-tsc/tsconfig.app.tsbuildinfo',
      types: ['node'],
    },
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts'],
  });
  writeJson(tree, `${projectRoot}/tsconfig.test.json`, {
    extends: base,
    compilerOptions: {
      outDir: 'out-tsc',
      rootDir: 'src',
      tsBuildInfoFile: 'out-tsc/tsconfig.test.tsbuildinfo',
      types: ['node'],
    },
    include: ['src/**/*.test.ts'],
    references: [{ path: './tsconfig.app.json' }],
  });
}

/** The image tag of a project name, as @nx/node sanitizes it: `@acme/backend` gives `acme-backend`. */
export function imageTagFor(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[@/]/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

interface ProjectIdentity {
  projectRoot: string;
  name: string;
  projectName: string;
  port: number;
  scope: string;
}

/**
 * The app manifest is its deploy manifest: `prune-lockfile` copies its
 * dependencies into dist/package.json, and @nx/dependency-checks keeps them
 * right, because the bundle leaves each npm package external.
 */
function writeProjectPackageJson(tree: Tree, app: ProjectIdentity): void {
  const imageTag = imageTagFor(app.projectName);
  updateJson(
    tree,
    `${app.projectRoot}/package.json`,
    (packageJson: ProjectPackageJson) => {
      const targets = { ...packageJson.nx?.targets };
      // Workspace libraries are bundled, so nothing is copied at deploy time;
      // prune-lockfile alone writes the runtime manifest and lockfile.
      delete targets['copy-workspace-modules'];
      delete targets['prune'];
      packageJson.type = 'module';
      packageJson.scripts = {};
      packageJson.dependencies = {
        ...packageJson.dependencies,
        '@godaddy/terminus': versions['@godaddy/terminus'],
        '@hono/node-server': versions['@hono/node-server'],
        '@sdk-it/hono': versions['@sdk-it/hono'],
        evlog: versions.evlog,
        hono: versions.hono,
        zod: versions.zod,
      };
      packageJson.nx = {
        ...packageJson.nx,
        // @nx/node writes no projectType into package.json. @zukhruf/eslint
        // reads it: an application bundles, so its manifest declares the npm
        // packages of each workspace package it imports, not the package.
        projectType: 'application',
        targets: {
          ...targets,
          build: buildTarget(app.projectRoot),
          // @nx/js/tsx infers the command from the header of src/server.ts.
          // @nx/node writes serve as continuous, and a project value wins
          // over the discrete target default. The app turns on its
          // development log drain only when NODE_ENV is development.
          serve: {
            dependsOn: ['^build'],
            options: { env: { NODE_ENV: 'development' } },
          },
          portless: {
            command: `portless --name ${app.name}.${app.scope} --app-port ${app.port} -- nx run ${app.projectName}:serve --output-style=stream-without-prefixes`,
          },
          'docker:build': {
            command: `docker build --file ${app.projectRoot}/Dockerfile --build-arg BUILD_SHA=$(git rev-parse HEAD) --tag ${imageTag} .`,
            options: { cwd: '{workspaceRoot}' },
          },
          'docker:run': {
            command: `docker run --rm --publish ${app.port}:${app.port} ${imageTag}`,
          },
        },
      };
      return packageJson;
    },
  );
}

/**
 * One ESM bundle in place of the CommonJS build of @nx/node. With `thirdParty`
 * unset, @nx/esbuild leaves each npm package external, also one that a bundled
 * workspace library imports, and inlines the workspace libraries.
 * `declaration: false` stops the executor from taking `declaration` from the
 * `composite` of the base tsconfig. The development configuration skips the
 * type check; typecheck and the production build keep it. The banner gives
 * the ESM bundle a `require` for an external CommonJS package.
 */
function buildTarget(projectRoot: string) {
  return {
    executor: '@nx/esbuild:esbuild',
    outputs: ['{options.outputPath}'],
    defaultConfiguration: 'production',
    options: {
      platform: 'node',
      target: 'esnext',
      bundle: true,
      format: ['esm'],
      main: `${projectRoot}/src/server.ts`,
      tsConfig: `${projectRoot}/tsconfig.app.json`,
      outputPath: `${projectRoot}/dist`,
      assets: [],
      declaration: false,
      sourcemap: true,
      esbuildOptions: { banner: { js: createRequireBanner } },
    },
    configurations: {
      development: { skipTypeCheck: true },
      production: {},
    },
  };
}

interface SdkOptions {
  projectRoot: string;
  name: string;
  projectName: string;
  rootOffset: string;
  scope: string;
}

function wireSdk(tree: Tree, options: SdkOptions): void {
  const { projectRoot, name, projectName, rootOffset, scope } = options;
  const packageName = `@${scope}/${name}-client`;
  tree.write(
    `${projectRoot}/sdk-it.config.ts`,
    sdkItConfig(projectName, packageName),
  );
  const stubPath = `${projectRoot}/.sdk-it/package.json`;
  if (!tree.exists(stubPath)) {
    tree.write(stubPath, clientManifest(packageName, projectName));
  }
  const tsconfigPath = `${projectRoot}/.sdk-it/tsconfig.json`;
  if (!tree.exists(tsconfigPath)) {
    tree.write(tsconfigPath, clientTsconfig(rootOffset));
  }
  // A path, not a glob: npm matches workspace globs without `dot`, so
  // `apps/*/.sdk-it` never links the package.
  updateJson(tree, 'package.json', (packageJson: { workspaces?: string[] }) => {
    packageJson.workspaces = unique([
      ...(packageJson.workspaces ?? []),
      `${projectRoot}/.sdk-it`,
    ]);
    return packageJson;
  });
  addLines(
    tree,
    '.gitignore',
    '**/.sdk-it/*\n!**/.sdk-it/package.json\n!**/.sdk-it/tsconfig.json\n',
  );
  addLines(tree, '.prettierignore', '.sdk-it\n');
}

/**
 * The nx.json keys of a backend. An executor-keyed default wins over a
 * name-keyed one (Nx takes the first key that matches and never merges two),
 * so the esbuild entry keeps the Tailwind sync generator of the `build`
 * default away from a backend build. `^sdk` builds a generated client before
 * its consumers build, serve, typecheck or test; it does nothing for a
 * project with no such dependency, and `...` keeps the `^build` that
 * @zukhruf/nx/test infers for test.
 */
function mergeNodeNxJson(tree: Tree): void {
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    updateTargetDefault(nxJson, '@nx/esbuild:esbuild', (entry) => ({
      ...entry,
      cache: true,
      dependsOn: unique([...(entry.dependsOn ?? []), '^build']),
      inputs: unique([
        ...(entry.inputs ?? []),
        'production',
        '^production',
        tsSolutionTsconfigInput,
      ]),
    }));
    for (const [target, inferred] of [
      ['build', []],
      ['dev', []],
      ['typecheck', []],
      ['test', ['...']],
    ] as const) {
      updateTargetDefault(nxJson, target, (entry) => ({
        ...entry,
        dependsOn: unique([...inferred, ...(entry.dependsOn ?? []), '^sdk']),
      }));
    }
    // sdk-it.config.ts imports the root CLI. Outside production, its closure
    // stays out of the pruned runtime lockfile of the app.
    nxJson.namedInputs ??= {};
    nxJson.namedInputs['production'] = unique([
      ...(nxJson.namedInputs['production'] ?? ['default']),
      '!{projectRoot}/sdk-it.config.{js,ts,mjs,mts}',
    ]);
    nxJson.generators = mergeGeneratorDefaults(nxJson.generators, '@nx/node', {
      application: {
        framework: 'none',
        bundler: 'esbuild',
        linter: 'eslint',
        unitTestRunner: 'none',
        e2eTestRunner: 'none',
        docker: false,
      },
    });
    return nxJson;
  });
}
