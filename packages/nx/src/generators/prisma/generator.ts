import { posix } from 'node:path';

import {
  type GeneratorCallback,
  type NxJsonConfiguration,
  type Tree,
  formatFiles,
  installPackagesTask,
  readJson,
  runTasksInSerial,
  updateJson,
  writeJson,
} from '@nx/devkit';

import { addLines } from '../add-lines.ts';
import { appDirectory } from '../app-directory.ts';
import { addEnvEntry } from '../env-file.ts';
import initGenerator from '../init/generator.ts';
import { pluginName, unique, updateTargetDefault } from '../init/nx-json.ts';
import { dockerignore, startupTs } from '../node-app/files.ts';
import {
  rootDependencyNames,
  settleRootDependencies,
} from '../root-dependencies.ts';
import { appPackageVersions as versions, zukhrufVersion } from '../versions.ts';
import { workspaceScope } from '../workspace-scope.ts';
import {
  type LocalDatabase,
  composeDevYml,
  databaseTestTs,
  envExample,
  eslintConfig,
  indexTs,
  localConnectionString,
  migrationDockerfile,
  migrationLockToml,
  prismaConfigTs,
  schemaPrisma,
  scriptsTsconfig,
  startupClientTs,
  testingTs,
} from './files.ts';

export interface PrismaOptions {
  /** The project root of the db package, for example `packages/db`. */
  directory: string;
  /** The project root of a node-app that connects to the database before it serves, for example `apps/backend`. */
  backend?: string;
  /** The host port of the local Postgres in compose.dev.yml. Two repos whose stacks run at once need two ports. */
  port?: number;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  nx?: {
    projectType?: string;
    tags?: string[];
    targets?: Record<string, { dependsOn?: unknown[] }>;
  };
}

/**
 * The npm packages of the db package. A backend bundles the package, so its
 * deploy manifest declares them in place of the package (ADR 0011).
 */
const packageDependencies = {
  '@prisma/adapter-pg': versions['@prisma/adapter-pg'],
  '@prisma/client': versions['@prisma/client'],
  pg: versions.pg,
  // importHelpers of the base: the emitted JavaScript imports tslib.
  tslib: versions.tslib,
};

const exportOf = (entry: string) => ({
  development: `./src/${entry}.ts`,
  types: `./dist/${entry}.d.ts`,
  import: `./dist/${entry}.js`,
  default: `./dist/${entry}.js`,
});

/**
 * A Postgres db package on Prisma 7 and @prisma/adapter-pg: the schema, the
 * config, the migrations folder, a client module, a test helper that applies
 * the migrations, and an image that runs `prisma migrate deploy`. The targets
 * come from @zukhruf/nx/prisma. With `backend`, the node-app connects to the
 * database before it serves. It runs `init` first. A second run keeps the
 * files of the package.
 */
export default async function prismaGenerator(
  tree: Tree,
  options: PrismaOptions,
): Promise<GeneratorCallback> {
  const initTask = await initGenerator(tree);
  const scope = workspaceScope(tree);
  const { projectRoot, name, rootOffset } = appDirectory(options.directory);
  const packageName = `@${scope}/${name}`;
  const database: LocalDatabase = { port: options.port ?? 5432, name: scope };
  const backendRoot =
    options.backend === undefined
      ? undefined
      : appDirectory(options.backend).projectRoot;
  if (
    backendRoot !== undefined &&
    !tree.exists(`${backendRoot}/sdk-it.config.ts`)
  ) {
    throw new Error(
      `${backendRoot} has no sdk-it.config.ts, so it is not a node-app. Run @zukhruf/nx:node-app ${backendRoot} first.`,
    );
  }
  const before = rootDependencyNames(tree);

  const packageJsonPath = `${projectRoot}/package.json`;
  if (tree.exists(packageJsonPath)) {
    const existing = readJson<PackageJson>(tree, packageJsonPath);
    if (existing.name !== packageName) {
      throw new Error(
        existing.name === undefined
          ? `${packageJsonPath} already exists and has no name.`
          : `${projectRoot} already belongs to ${existing.name}.`,
      );
    }
  } else {
    writePackage(tree, { projectRoot, rootOffset, packageName, database });
  }
  if (!tree.exists('compose.dev.yml')) {
    tree.write('compose.dev.yml', composeDevYml(database, packageName));
  }
  addWorkspace(tree, projectRoot);
  addLines(tree, '.gitignore', `${projectRoot}/src/prisma\n`);
  addLines(tree, '.prettierignore', `${projectRoot}/src/prisma\n`);
  if (!tree.exists('.dockerignore')) {
    tree.write('.dockerignore', dockerignore);
  }
  mergePrismaNxJson(tree);
  if (backendRoot !== undefined) {
    wireBackend(tree, backendRoot, packageName, database);
  }

  settleRootDependencies(tree, before, {
    // The tests of a db package and of its backend take a database from it.
    devDependencies: { '@zukhruf/testing': zukhrufVersion },
    // @prisma/engines downloads the schema engine that migrate deploy runs.
    // The preinstall of prisma only checks the Node version. @zukhruf/testing
    // brings ssh2, whose native crypto binding and cpu-features are optional:
    // ssh2 falls back to JavaScript, as in zukhruf, factory and text2sql.
    allowScripts: {
      '@prisma/engines': true,
      prisma: false,
      ssh2: false,
      'cpu-features': false,
    },
  });

  await formatFiles(tree);
  return runTasksInSerial(initTask, () => installPackagesTask(tree));
}

/**
 * The targets of the local Postgres of compose.dev.yml. up starts it, waits
 * for its healthcheck and applies the migrations; its env names the local
 * database, so a CONNECTION_STRING in the shell never gets them. down stops
 * it and keeps the volume. `rootOffset` leads from the db package to the
 * workspace root. The add-local-postgres migration writes the same targets.
 */
export function localDatabaseTargets(
  rootOffset: string,
  database: LocalDatabase,
) {
  const compose = `docker compose --file ${rootOffset}compose.dev.yml`;
  return {
    up: {
      executor: 'nx:run-commands',
      options: {
        commands: [
          `${compose} up --detach --wait database`,
          'prisma migrate deploy',
        ],
        parallel: false,
        cwd: '{projectRoot}',
        env: {
          NODE_ENV: 'production',
          CONNECTION_STRING: localConnectionString(database),
        },
      },
    },
    down: {
      command: `${compose} down`,
      options: { cwd: '{projectRoot}' },
    },
  };
}

interface PackageIdentity {
  projectRoot: string;
  rootOffset: string;
  packageName: string;
  database: LocalDatabase;
}

function writePackage(tree: Tree, identity: PackageIdentity): void {
  const { projectRoot, rootOffset, packageName, database } = identity;
  writeJson(tree, `${projectRoot}/package.json`, {
    name: packageName,
    version: '0.0.1',
    private: true,
    type: 'module',
    main: './dist/index.js',
    module: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      './package.json': './package.json',
      '.': exportOf('index'),
      './testing': exportOf('testing'),
    },
    dependencies: packageDependencies,
    // The migration image installs the CLI from here.
    devDependencies: {
      '@types/pg': versions['@types/pg'],
      prisma: versions.prisma,
    },
    nx: {
      tags: ['test:docker'],
      targets: localDatabaseTargets(rootOffset, database),
    },
  });
  const base = `${rootOffset}tsconfig.base.json`;
  writeJson(tree, `${projectRoot}/tsconfig.json`, {
    extends: base,
    files: [],
    include: [],
    references: [
      { path: './tsconfig.lib.json' },
      { path: './tsconfig.test.json' },
      { path: './tsconfig.scripts.json' },
    ],
  });
  // The base emits declarations only. The build emits JavaScript too, and
  // rewrites the `.ts` imports of the generated client to `.js`.
  writeJson(tree, `${projectRoot}/tsconfig.lib.json`, {
    extends: base,
    compilerOptions: {
      outDir: 'dist',
      rootDir: 'src',
      tsBuildInfoFile: 'dist/tsconfig.lib.tsbuildinfo',
      emitDeclarationOnly: false,
      rewriteRelativeImportExtensions: true,
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
    references: [{ path: './tsconfig.lib.json' }],
  });
  writeJson(
    tree,
    `${projectRoot}/tsconfig.scripts.json`,
    scriptsTsconfig(rootOffset),
  );
  tree.write(`${projectRoot}/eslint.config.mjs`, eslintConfig(rootOffset));
  tree.write(`${projectRoot}/prisma.config.ts`, prismaConfigTs);
  tree.write(`${projectRoot}/schema.prisma`, schemaPrisma);
  // The migration image copies models/, so it is in Git before the first model.
  tree.write(`${projectRoot}/models/.gitkeep`, '');
  tree.write(
    `${projectRoot}/migrations/migration_lock.toml`,
    migrationLockToml,
  );
  tree.write(`${projectRoot}/src/index.ts`, indexTs);
  tree.write(`${projectRoot}/src/testing.ts`, testingTs);
  tree.write(
    `${projectRoot}/src/index.test.ts`,
    databaseTestTs({ client: './index.ts', testing: './testing.ts' }),
  );
  tree.write(`${projectRoot}/.env.example`, envExample(database));
  if (!tree.exists(`${projectRoot}/.env`)) {
    tree.write(`${projectRoot}/.env`, envExample(database));
  }
  tree.write(
    `${projectRoot}/Dockerfile.migration`,
    migrationDockerfile({ projectRoot, packageName }),
  );
}

/** `npm ci --workspace` of the migration image needs the package in `workspaces`. */
function addWorkspace(tree: Tree, projectRoot: string): void {
  updateJson(tree, 'package.json', (packageJson: { workspaces?: string[] }) => {
    const workspaces = packageJson.workspaces ?? [];
    if (
      !workspaces.includes(projectRoot) &&
      !workspaces.includes(`${posix.dirname(projectRoot)}/*`)
    ) {
      packageJson.workspaces = [...workspaces, projectRoot];
    }
    return packageJson;
  });
}

/**
 * The plugin gives the Prisma targets. `migrate:check` runs before each
 * typecheck (ADR 0018). init runs `generate` before each task that reads the
 * client and hashes it (ADR 0019).
 */
function mergePrismaNxJson(tree: Tree): void {
  updateJson(tree, 'nx.json', (nxJson: NxJsonConfiguration) => {
    const plugins = nxJson.plugins ?? [];
    if (!plugins.some((entry) => pluginName(entry) === '@zukhruf/nx/prisma')) {
      nxJson.plugins = [...plugins, '@zukhruf/nx/prisma'];
    }
    addMigrateCheck(nxJson);
    return nxJson;
  });
}

/**
 * `migrate:check` in `targetDefaults.typecheck`, as `format:check` is, so a
 * schema change without its migration fails the typecheck of the db package
 * (ADR 0018). The generator and the add-migrate-check migration call it.
 */
export function addMigrateCheck(nxJson: NxJsonConfiguration): void {
  updateTargetDefault(nxJson, 'typecheck', (entry) => ({
    ...entry,
    dependsOn: unique([...(entry.dependsOn ?? []), 'migrate:check', '...']),
  }));
}

/** Replaces `marker` in a file of the backend, or stops when the file has no marker. */
function insert(
  tree: Tree,
  path: string,
  marker: string,
  replacement: string,
): void {
  const content = tree.read(path, 'utf-8');
  if (content === null || !content.includes(marker)) {
    throw new Error(
      `${path} has no ${JSON.stringify(marker)}, so the generator cannot wire the database into it.`,
    );
  }
  tree.write(path, content.replace(marker, replacement));
}

/**
 * The backend declares CONNECTION_STRING, connects the client in startup.ts
 * before it serves, and disconnects it when terminus gets SIGTERM. Its serve
 * runs the up target of the db package first. Each step is skipped when the
 * backend already has it.
 */
function wireBackend(
  tree: Tree,
  backendRoot: string,
  packageName: string,
  database: LocalDatabase,
) {
  const envPath = `${backendRoot}/src/env.ts`;
  if (!tree.read(envPath, 'utf-8')?.includes('CONNECTION_STRING:')) {
    insert(
      tree,
      envPath,
      'const env = z.object({\n',
      `const env = z.object({\n  // The Postgres database of ${packageName}.\n  CONNECTION_STRING: z.string().min(1),\n`,
    );
  }
  const connectionString = localConnectionString(database);
  addEnvEntry(
    tree,
    `${backendRoot}/.env.example`,
    'CONNECTION_STRING',
    connectionString,
  );
  if (tree.exists(`${backendRoot}/.env`)) {
    addEnvEntry(
      tree,
      `${backendRoot}/.env`,
      'CONNECTION_STRING',
      connectionString,
    );
  }

  const startupPath = `${backendRoot}/src/startup.ts`;
  const startup = tree.read(startupPath, 'utf-8') ?? '';
  if (!startup.includes(`from '${packageName}'`)) {
    // The placeholder of node-app goes; a startup.ts with code keeps it.
    tree.write(
      startupPath,
      startup === startupTs
        ? `import './env.ts';\n\n${startupClientTs(packageName)}`
        : `${startup}\n${startupClientTs(packageName)}`,
    );
  }

  const serverPath = `${backendRoot}/src/server.ts`;
  if (!tree.read(serverPath, 'utf-8')?.includes('prisma.$disconnect()')) {
    insert(
      tree,
      serverPath,
      "import './startup.ts';",
      "import { prisma } from './startup.ts';",
    );
    insert(
      tree,
      serverPath,
      '    await flushLogs();\n',
      '    await prisma.$disconnect();\n    await flushLogs();\n',
    );
  }

  updateJson(
    tree,
    `${backendRoot}/package.json`,
    (packageJson: PackageJson) => {
      // The esbuild bundle inlines the db package and leaves its npm packages
      // external, so prune-lockfile and dependency-checks need them here.
      packageJson.dependencies = {
        ...packageJson.dependencies,
        ...packageDependencies,
      };
      // serve starts the local Postgres and migrates it first, so the
      // backend and its portless target start on a machine with no database.
      // ^up reaches the db package through the import graph
      // (zukhruf/no-depends-on-project refuses a named project).
      const targets = packageJson.nx?.targets ?? {};
      const serve = targets['serve'] ?? {};
      packageJson.nx = {
        ...packageJson.nx,
        tags: unique([...(packageJson.nx?.tags ?? []), 'test:docker']),
        targets: {
          ...targets,
          serve: {
            ...serve,
            dependsOn: unique([...(serve.dependsOn ?? []), '^up']),
          },
        },
      };
      return packageJson;
    },
  );
  const testPath = `${backendRoot}/src/database.test.ts`;
  if (!tree.exists(testPath)) {
    tree.write(
      testPath,
      databaseTestTs({
        client: packageName,
        testing: `${packageName}/testing`,
      }),
    );
  }
}
