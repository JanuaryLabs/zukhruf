import {
  type GeneratorCallback,
  type Tree,
  formatFiles,
  readJson,
  runTasksInSerial,
  updateJson,
  writeJson,
} from '@nx/devkit';

import { appDirectory } from '../app-directory.ts';
import initGenerator from '../init/generator.ts';
import { nxPlugin } from '../nx-plugin.ts';
import {
  reactEslintConfig,
  reactResidue,
  reactRootPackages,
} from '../react.ts';
import {
  rootDependencyNames,
  settleRootDependencies,
} from '../root-dependencies.ts';
import { appPackageVersions as versions } from '../versions.ts';
import {
  libraryTsconfig,
  publicApiTest,
  rootTsconfig,
  specTsconfig,
  viteConfig,
} from './files.ts';

export interface UiPackageOptions {
  /** The package folder under packages/, for example `packages/ui`. */
  directory: string;
  /** The package name, for example `@acme/ui`. */
  importPath: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  nx?: { targets?: Record<string, unknown> };
}

/**
 * A buildable React package: a Vite library build with types, a `development`
 * export condition that points at the source, and a node test of the public
 * export. It runs `init` first. A second run keeps the package as it is.
 */
export default async function uiPackageGenerator(
  tree: Tree,
  options: UiPackageOptions,
): Promise<GeneratorCallback> {
  const initTask = await initGenerator(tree);
  const { projectRoot, rootOffset } = appDirectory(options.directory);
  if (!projectRoot.startsWith('packages/')) {
    throw new Error(
      `A UI package goes under packages/, not ${JSON.stringify(options.directory)}.`,
    );
  }
  if (
    !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(options.importPath)
  ) {
    throw new Error(
      `The import path ${JSON.stringify(options.importPath)} is not a scoped package name, for example "@acme/ui".`,
    );
  }

  const packageJsonPath = `${projectRoot}/package.json`;
  if (tree.exists(packageJsonPath)) {
    const existing = readJson<PackageJson>(tree, packageJsonPath);
    if (existing.name !== options.importPath) {
      throw new Error(
        existing.name === undefined
          ? `${packageJsonPath} already exists and has no name.`
          : `${projectRoot} already belongs to ${existing.name}.`,
      );
    }
    return initTask;
  }

  const before = rootDependencyNames(tree);
  const { libraryGenerator } = nxPlugin('@nx/react');
  const libraryTask = await libraryGenerator(tree, {
    directory: projectRoot,
    importPath: options.importPath,
    bundler: 'vite',
    compiler: 'babel',
    component: false,
    linter: 'eslint',
    strict: true,
    style: 'none',
    unitTestRunner: 'none',
    useProjectJson: false,
    addPlugin: true,
    skipFormat: true,
  });

  tree.delete(`${projectRoot}/.babelrc`);
  tree.delete(`${projectRoot}/README.md`);
  tree.delete(`${projectRoot}/vite.config.mts`);
  tree.write(
    `${projectRoot}/vite.config.ts`,
    viteConfig(projectRoot, rootOffset, options.importPath),
  );
  tree.write(
    `${projectRoot}/eslint.config.mjs`,
    reactEslintConfig(rootOffset, ['tailwind']),
  );
  writeJson(tree, `${projectRoot}/tsconfig.json`, rootTsconfig(rootOffset));
  writeJson(
    tree,
    `${projectRoot}/tsconfig.lib.json`,
    libraryTsconfig(rootOffset),
  );
  writeJson(
    tree,
    `${projectRoot}/tsconfig.spec.json`,
    specTsconfig(rootOffset),
  );
  tree.write(
    `${projectRoot}/src/index.ts`,
    `export const packageName = '${options.importPath}';\n`,
  );
  tree.write(
    `${projectRoot}/tests/public-api.test.mjs`,
    publicApiTest(options.importPath),
  );

  updateJson(tree, packageJsonPath, (packageJson: PackageJson) => {
    packageJson.name = options.importPath;
    packageJson.version = '0.1.0';
    packageJson.private = true;
    packageJson.type = 'module';
    packageJson.main = './dist/index.js';
    packageJson.module = './dist/index.js';
    packageJson.types = './dist/index.d.ts';
    packageJson.exports = {
      './package.json': './package.json',
      '.': {
        development: './src/index.ts',
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    };
    packageJson.dependencies = { react: versions.react };
    packageJson.devDependencies = {
      '@rolldown/plugin-babel': versions['@rolldown/plugin-babel'],
      '@tailwindcss/vite': versions['@tailwindcss/vite'],
      '@vitejs/plugin-react': versions['@vitejs/plugin-react'],
      'babel-plugin-react-compiler': versions['babel-plugin-react-compiler'],
      vite: versions.vite,
      'vite-plugin-dts': versions['vite-plugin-dts'],
    };
    packageJson.scripts = {};
    packageJson.nx = {
      ...packageJson.nx,
      targets: {
        ...packageJson.nx?.targets,
        // The test imports the package through its export, which is dist.
        test: { dependsOn: ['...', 'build'] },
      },
    };
    return packageJson;
  });

  settleRootDependencies(tree, before, {
    devDependencies: reactRootPackages,
    // The babel compiler and vite-plugin-dts of @nx/react go to the root;
    // the package declares what its own vite.config.ts loads.
    residue: [
      ...reactResidue,
      '@babel/core',
      '@babel/preset-react',
      'ajv',
      'vite-plugin-dts',
    ],
  });

  await formatFiles(tree);
  return runTasksInSerial(initTask, libraryTask);
}
