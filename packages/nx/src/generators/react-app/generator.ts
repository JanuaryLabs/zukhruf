import {
  type GeneratorCallback,
  type NxJsonConfiguration,
  type Tree,
  formatFiles,
  installPackagesTask,
  readJson,
  runTasksInSerial,
  updateJson,
} from '@nx/devkit';

import { addMissingKeys } from '../add-keys.ts';
import { appDirectory, projectNameOf } from '../app-directory.ts';
import initGenerator from '../init/generator.ts';
import {
  mergeGeneratorDefaults,
  pluginName,
  unique,
  updateTargetDefault,
} from '../init/nx-json.ts';
import { nxPlugin } from '../nx-plugin.ts';
import {
  reactEslintConfig,
  reactResidue,
  reactRootPackages,
  tailwindSyncOverrides,
} from '../react.ts';
import {
  fseventsScript,
  rootDependencyNames,
  settleRootDependencies,
} from '../root-dependencies.ts';
import { appPackageVersions as versions } from '../versions.ts';
import { workspaceScope } from '../workspace-scope.ts';
import {
  appTestTsx,
  appTsx,
  indexHtml,
  mainTsx,
  stylesCss,
  viteConfig,
} from './files.ts';

export interface ReactAppOptions {
  /** The project root, for example `apps/web`. */
  directory: string;
}

interface ProjectPackageJson {
  type?: string;
  sideEffects?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  nx?: { targets?: Record<string, unknown> };
}

interface Tsconfig {
  compilerOptions?: { types?: string[]; [option: string]: unknown };
  include?: string[];
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const tailwindSyncGenerator = '@juristr/nx-tailwind-sync:source-directives';

/**
 * A React Router 8 SPA in data mode on Vite: React Compiler, Tailwind 4,
 * precompressed assets, a dev proxy to `/api`, and Vitest component tests.
 * It runs `init` first.
 */
export default async function reactAppGenerator(
  tree: Tree,
  options: ReactAppOptions,
): Promise<GeneratorCallback> {
  const initTask = await initGenerator(tree);
  const scope = workspaceScope(tree);
  const { projectRoot, name, rootOffset } = appDirectory(options.directory);
  const before = rootDependencyNames(tree);

  const { applicationGenerator } = nxPlugin('@nx/react');
  const appTask = await applicationGenerator(tree, {
    directory: projectRoot,
    bundler: 'vite',
    style: 'css',
    linter: 'eslint',
    unitTestRunner: 'none',
    e2eTestRunner: 'none',
    routing: false,
    useReactRouter: false,
    strict: true,
    useProjectJson: false,
    addPlugin: true,
    skipFormat: true,
  });
  const projectName = projectNameOf(tree, projectRoot);

  tree.delete(`${projectRoot}/src/app/nx-welcome.tsx`);
  tree.delete(`${projectRoot}/src/app/app.module.css`);
  tree.delete(`${projectRoot}/vite.config.mts`);
  tree.delete(`${projectRoot}/public/favicon.ico`);
  tree.write(`${projectRoot}/index.html`, indexHtml(name));
  tree.write(`${projectRoot}/src/styles.css`, stylesCss);
  tree.write(`${projectRoot}/src/main.tsx`, mainTsx);
  tree.write(`${projectRoot}/src/app/app.tsx`, appTsx(name));
  tree.write(`${projectRoot}/src/app/app.test.tsx`, appTestTsx);
  tree.write(
    `${projectRoot}/vite.config.ts`,
    viteConfig(name, projectRoot, rootOffset),
  );
  tree.write(
    `${projectRoot}/eslint.config.mjs`,
    reactEslintConfig(rootOffset, ['react-router', 'tailwind']),
  );
  // tsc --build writes to out-tsc, so its output stays out of Vite's dist.
  updateJson(tree, `${projectRoot}/tsconfig.app.json`, (config: Tsconfig) => {
    config.compilerOptions = {
      ...config.compilerOptions,
      outDir: 'out-tsc',
      tsBuildInfoFile: 'out-tsc/tsconfig.app.tsbuildinfo',
    };
    return config;
  });
  writeProjectPackageJson(tree, { projectRoot, name, projectName, scope });

  const testTask = await addComponentTests(tree, projectRoot, projectName);
  mergeReactNxJson(tree);

  settleRootDependencies(tree, before, {
    devDependencies: {
      ...reactRootPackages,
      '@juristr/nx-tailwind-sync': versions['@juristr/nx-tailwind-sync'],
      '@testing-library/dom': versions['@testing-library/dom'],
      '@testing-library/jest-dom': versions['@testing-library/jest-dom'],
      '@testing-library/react': versions['@testing-library/react'],
      '@types/node': versions['@types/node'],
      tslib: versions.tslib,
      '@vitest/coverage-v8': versions['@vitest/coverage-v8'],
      'happy-dom': versions['happy-dom'],
      'prettier-plugin-tailwindcss': versions['prettier-plugin-tailwindcss'],
      vitest: versions.vitest,
    },
    // The UI of Vitest: no target runs it.
    residue: [...reactResidue, '@vitest/ui'],
    allowScripts: fseventsScript,
    overrides: tailwindSyncOverrides,
  });

  await formatFiles(tree);
  await addTailwindPrettierPlugin(tree);
  return runTasksInSerial(initTask, appTask, testTask, () =>
    installPackagesTask(tree),
  );
}

interface ProjectIdentity {
  projectRoot: string;
  name: string;
  projectName: string;
  scope: string;
}

function writeProjectPackageJson(tree: Tree, app: ProjectIdentity): void {
  updateJson(
    tree,
    `${app.projectRoot}/package.json`,
    (packageJson: ProjectPackageJson) => {
      packageJson.type = 'module';
      packageJson.sideEffects = false;
      packageJson.scripts = {};
      packageJson.dependencies = {
        ...packageJson.dependencies,
        react: versions.react,
        'react-dom': versions['react-dom'],
        'react-router': versions['react-router'],
      };
      packageJson.devDependencies = {
        ...packageJson.devDependencies,
        'vite-plugin-compression2': versions['vite-plugin-compression2'],
      };
      packageJson.nx = {
        ...packageJson.nx,
        targets: {
          ...packageJson.nx?.targets,
          portless: {
            command: `portless --name ${app.name}.${app.scope} -- nx run ${app.projectName}:dev --output-style=stream-without-prefixes`,
          },
        },
      };
      return packageJson;
    },
  );
}

/**
 * Vitest component tests. vite.config.ts holds the `test` block, so
 * @nx/vitest writes no Vite config; it registers its plugin, which infers the
 * test target, and writes tsconfig.spec.json.
 */
async function addComponentTests(
  tree: Tree,
  projectRoot: string,
  projectName: string,
): Promise<GeneratorCallback> {
  const testDefault = readJson<NxJsonConfiguration>(tree, 'nx.json')
    .targetDefaults?.['test'];
  const { configurationGenerator } = nxPlugin('@nx/vitest/generators');
  const task = await configurationGenerator(tree, {
    project: projectName,
    uiFramework: 'react',
    testEnvironment: 'happy-dom',
    coverageProvider: 'v8',
    addPlugin: true,
    skipViteConfig: true,
    skipFormat: true,
  });

  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    // In a TS solution workspace, @nx/vitest adds ^build to the test default.
    // The test default stays as it was: ["...", "^sdk"] after node-app.
    if (testDefault === undefined) {
      delete nxJson.targetDefaults?.['test'];
    } else {
      nxJson.targetDefaults = { ...nxJson.targetDefaults, test: testDefault };
    }
    // `vitest` alone watches in a terminal; the test target runs once.
    nxJson.plugins = (nxJson.plugins ?? []).map((entry) => {
      if (pluginName(entry) !== '@nx/vitest') return entry;
      const options =
        typeof entry === 'object' && isRecord(entry.options)
          ? entry.options
          : {};
      return { plugin: '@nx/vitest', options: { ...options, testMode: 'run' } };
    });
    return nxJson;
  });

  // The project target, not a target default: a default with a list entry
  // replaces the cwd, cache and inputs of the inferred target (Nx 24). It
  // builds the generated client first. Vitest sets NODE_ENV only when it is
  // unset, and production loads the React build that has no act().
  updateJson(
    tree,
    `${projectRoot}/package.json`,
    (packageJson: ProjectPackageJson) => {
      packageJson.nx = {
        ...packageJson.nx,
        targets: {
          ...packageJson.nx?.targets,
          test: {
            dependsOn: ['^sdk'],
            options: { env: { NODE_ENV: 'test' } },
          },
        },
      };
      return packageJson;
    },
  );

  // The spec tsconfig of @nx/vitest has no JSX and no DOM lib, lists only the
  // test files though the tests import the app, and lacks the jest-dom
  // matcher types that setupFiles registers.
  updateJson(tree, `${projectRoot}/tsconfig.spec.json`, (config: Tsconfig) => {
    config.compilerOptions = {
      ...config.compilerOptions,
      jsx: 'react-jsx',
      lib: ['ES2020', 'DOM', 'DOM.Iterable', 'DOM.AsyncIterable', 'ESNext'],
      types: unique([
        ...(config.compilerOptions?.types ?? []).filter(
          (type) => type !== 'vitest/globals',
        ),
        '@testing-library/jest-dom/vitest',
      ]),
    };
    config.include = unique([
      ...(config.include ?? []),
      'src/**/*.ts',
      'src/**/*.tsx',
    ]);
    return config;
  });
  return task;
}

/**
 * The nx.json keys of a React app: the Tailwind sync generator writes the
 * `@source` lines of styles.css before a build, dev or serve, and the
 * defaults of `nx g @nx/react:*`.
 */
function mergeReactNxJson(tree: Tree): void {
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    nxJson.sync = {
      ...nxJson.sync,
      generatorOptions: {
        ...nxJson.sync?.generatorOptions,
        [tailwindSyncGenerator]: { additionalStylePaths: ['styles.css'] },
      },
    };
    for (const target of ['build', 'dev', 'serve']) {
      updateTargetDefault(nxJson, target, (entry) => ({
        ...entry,
        syncGenerators: unique([
          ...(entry.syncGenerators ?? []),
          tailwindSyncGenerator,
        ]),
      }));
    }
    // One portless proxy serves every app on the machine, and the target that
    // starts it sets its mode. PORTLESS_UNPRIVILEGED starts it without sudo,
    // so an agent with no TTY can. PORTLESS_HTTPS keeps it on HTTPS: a
    // stopped unprivileged proxy otherwise restarts on plain HTTP, and the HMR
    // of vite.config.ts dials wss on 443. No PORTLESS_TLD: localhost is the
    // default, and a set TLD replaces the TLDs that another repo's proxy
    // saved. Copy in node-app (docs/copied-code.md).
    updateTargetDefault(nxJson, 'portless', (entry) => ({
      ...entry,
      options: {
        ...entry.options,
        env: addMissingKeys(entry.options?.env, {
          PORTLESS_UNPRIVILEGED: '1',
          PORTLESS_HTTPS: '1',
        }),
      },
    }));
    nxJson.generators = mergeGeneratorDefaults(nxJson.generators, '@nx/react', {
      application: {
        style: 'css',
        linter: 'eslint',
        bundler: 'vite',
        unitTestRunner: 'none',
        e2eTestRunner: 'none',
        routing: false,
      },
      component: { style: 'css' },
      library: { style: 'css', linter: 'eslint', unitTestRunner: 'none' },
    });
    return nxJson;
  });
}

/**
 * Sorts the Tailwind classes with the formatter. It runs after formatFiles,
 * because Prettier loads each plugin of .prettierrc and the install callback
 * installs this one, so it formats .prettierrc itself, with no plugin.
 */
async function addTailwindPrettierPlugin(tree: Tree): Promise<void> {
  if (!tree.exists('.prettierrc')) return;
  const config = readJson<{ plugins?: string[] }>(tree, '.prettierrc');
  config.plugins = unique([
    ...(config.plugins ?? []),
    'prettier-plugin-tailwindcss',
  ]);
  const { format } = await import('prettier');
  tree.write(
    '.prettierrc',
    await format(JSON.stringify(config), { parser: 'json' }),
  );
}
