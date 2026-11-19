import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

import {
  type GeneratorCallback,
  type Tree,
  formatFiles,
  installPackagesTask,
  readJson,
  runTasksInSerial,
  updateJson,
} from '@nx/devkit';

import { appDirectory, projectNameOf } from '../app-directory.ts';
import initGenerator from '../init/generator.ts';
import { portOf } from '../pair/generator.ts';
import {
  rootDependencyNames,
  settleRootDependencies,
} from '../root-dependencies.ts';
import { appPackageVersions as versions } from '../versions.ts';
import {
  authCliTs,
  authEnvTs,
  authMount,
  authPrisma,
  authRouteTs,
  authTs,
  startupAuthTs,
} from './files.ts';

export interface AuthOptions {
  /** The project root of a node-app that a db package is wired into, for example `apps/backend`. */
  backend: string;
  /** The project root of the db package of the prisma generator, for example `packages/db`. */
  db: string;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  nx?: { targets?: Record<string, unknown> };
}

/** The module that the better-auth CLI loads, relative to the backend root. */
const cliConfig = 'src/auth.cli.ts';

/**
 * better-auth on a node-app and the db package that it is wired to: the auth
 * factory, the CLI config, the routes under /api/auth, the environment, the
 * models of better-auth in the db package, and the auth:generate and
 * auth:check targets. It runs `init` first. After the install, a task runs
 * auth:generate, which writes the models. A second run keeps the files it
 * wrote and adds nothing twice. It writes no migration (ADR 0012).
 */
export default async function authGenerator(
  tree: Tree,
  options: AuthOptions,
): Promise<GeneratorCallback> {
  const initTask = await initGenerator(tree);
  const backendRoot = appDirectory(options.backend).projectRoot;
  const dbRoot = appDirectory(options.db).projectRoot;
  if (!tree.exists(`${backendRoot}/sdk-it.config.ts`)) {
    throw new Error(
      `${backendRoot} has no sdk-it.config.ts, so it is not a node-app. Run @zukhruf/nx:node-app ${backendRoot} first.`,
    );
  }
  if (
    !tree.exists(`${dbRoot}/prisma.config.ts`) ||
    !tree
      .read(`${dbRoot}/src/index.ts`, 'utf-8')
      ?.includes('export function createPrisma(')
  ) {
    throw new Error(
      `${dbRoot} has no prisma.config.ts and createPrisma, so it is not a db package. Run @zukhruf/nx:prisma ${dbRoot} first.`,
    );
  }
  const dbPackageName = readJson<PackageJson>(
    tree,
    `${dbRoot}/package.json`,
  ).name;
  if (dbPackageName === undefined) {
    throw new Error(`${dbRoot}/package.json has no name.`);
  }
  const startupPath = `${backendRoot}/src/startup.ts`;
  const startup = tree.read(startupPath, 'utf-8') ?? '';
  if (!startup.includes(`from '${dbPackageName}';\n`)) {
    throw new Error(
      `${startupPath} does not create the client of ${dbPackageName}. Run @zukhruf/nx:prisma ${dbRoot} --backend ${backendRoot} first.`,
    );
  }
  const backendName = projectNameOf(tree, backendRoot);
  const dbName = projectNameOf(tree, dbRoot);
  const before = rootDependencyNames(tree);

  writeIfMissing(tree, `${backendRoot}/src/auth.ts`, authTs(dbPackageName));
  writeIfMissing(tree, `${backendRoot}/${cliConfig}`, authCliTs(dbPackageName));
  writeIfMissing(tree, `${backendRoot}/src/routes/auth.route.ts`, authRouteTs);
  writeIfMissing(tree, `${dbRoot}/models/auth.prisma`, authPrisma);
  wireStartup(tree, startupPath, dbPackageName);
  mountRoutes(tree, `${backendRoot}/src/app.ts`);
  wireEnvironment(tree, backendRoot);
  updateJson(
    tree,
    `${backendRoot}/package.json`,
    (packageJson: PackageJson) => {
      packageJson.dependencies = {
        ...packageJson.dependencies,
        'better-auth': versions['better-auth'],
      };
      packageJson.nx = {
        ...packageJson.nx,
        targets: {
          ...packageJson.nx?.targets,
          ...authTargets({ backendRoot, dbRoot, dbName }),
        },
      };
      return packageJson;
    },
  );

  // The CLI of better-auth is a tool of the workspace, as the sdk-it CLI is.
  settleRootDependencies(tree, before, {
    devDependencies: { auth: versions.auth },
  });

  await formatFiles(tree);
  return runTasksInSerial(
    initTask,
    () => installPackagesTask(tree),
    () => generateModels(tree.root, backendName),
  );
}

function writeIfMissing(tree: Tree, path: string, content: string): void {
  if (!tree.exists(path)) tree.write(path, content);
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
      `${path} has no ${JSON.stringify(marker)}, so the generator cannot wire auth into it.`,
    );
  }
  tree.write(path, content.replace(marker, replacement));
}

/** Adds `KEY=value` to an env file that has no line for the key. */
function addEnvEntry(
  tree: Tree,
  path: string,
  key: string,
  value: string,
): void {
  const content = tree.read(path, 'utf-8') ?? '';
  if (new RegExp(`^${key}=`, 'm').test(content)) return;
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  tree.write(path, `${content}${separator}${key}=${value}\n`);
}

/** startup.ts creates the auth from the client that the prisma generator wired. */
function wireStartup(tree: Tree, path: string, dbPackageName: string): void {
  if (tree.read(path, 'utf-8')?.includes('export const auth =')) return;
  const dbImport = `from '${dbPackageName}';\n`;
  insert(
    tree,
    path,
    dbImport,
    `${dbImport}\nimport { createAuth } from './auth.ts';\n`,
  );
  tree.write(path, `${tree.read(path, 'utf-8')}${startupAuthTs}`);
}

/**
 * The auth routes go before the UI mount of pair and before notFound, so the
 * catch-all of the web build never answers them.
 */
function mountRoutes(tree: Tree, path: string): void {
  const app = tree.read(path, 'utf-8') ?? '';
  if (app.includes(authMount)) return;
  const uiMount = `(await import('./routes/ui.route.ts')).default(app);`;
  const marker = app.includes(uiMount)
    ? `\n// pair fixed the path of the web build`
    : '\napp.notFound((c) =>';
  insert(
    tree,
    path,
    marker,
    `\n// better-auth answers under /api/auth.\n${authMount}\n${marker}`,
  );
}

function wireEnvironment(tree: Tree, backendRoot: string): void {
  const envPath = `${backendRoot}/src/env.ts`;
  if (!tree.read(envPath, 'utf-8')?.includes('BETTER_AUTH_SECRET:')) {
    insert(
      tree,
      envPath,
      'const env = z.object({\n',
      `const env = z.object({\n${authEnvTs}`,
    );
  }
  const url = `http://localhost:${portOf(tree, backendRoot)}`;
  const examplePath = `${backendRoot}/.env.example`;
  addEnvEntry(tree, examplePath, 'BETTER_AUTH_SECRET', '');
  addEnvEntry(tree, examplePath, 'BETTER_AUTH_URL', url);
  // .env is the developer's copy and is not committed, so it gets a secret of
  // its own.
  const envFilePath = `${backendRoot}/.env`;
  if (tree.exists(envFilePath)) {
    addEnvEntry(
      tree,
      envFilePath,
      'BETTER_AUTH_SECRET',
      randomBytes(32).toString('base64url'),
    );
    addEnvEntry(tree, envFilePath, 'BETTER_AUTH_URL', url);
  }
}

interface TargetOptions {
  backendRoot: string;
  dbRoot: string;
  dbName: string;
}

/**
 * The CLI imports the db package through its development export, which
 * imports the generated client, so the client is generated first. NODE_OPTIONS
 * gives jiti the development condition. NODE_ENV is development also where the
 * shell sets production, because the CLI refuses the placeholder secret in
 * production. auth:check only reads: it compares the
 * generated client with the plugins of the config, and exits 1 on a mismatch.
 */
function authTargets(options: TargetOptions) {
  const { backendRoot, dbRoot, dbName } = options;
  const output = posix.relative(backendRoot, `${dbRoot}/models/auth.prisma`);
  // The backend imports the db package, so `^generate` generates its client.
  const generateClient = ['^generate'];
  const shared = {
    cwd: '{projectRoot}',
    env: {
      NODE_OPTIONS: '--conditions=development',
      NODE_ENV: 'development',
    },
  };
  return {
    'auth:generate': {
      executor: 'nx:run-commands',
      dependsOn: generateClient,
      options: {
        ...shared,
        commands: [
          `npx auth generate --adapter prisma --config ${cliConfig} --output ${output} --yes`,
          `npx nx run ${dbName}:generate`,
        ],
        parallel: false,
      },
    },
    'auth:check': {
      executor: 'nx:run-commands',
      dependsOn: generateClient,
      options: {
        ...shared,
        command: `npx auth check schema --config ${cliConfig}`,
      },
    },
  };
}

/**
 * Runs auth:generate after the install, so the CLI writes the models of the
 * plugins into the placeholder.
 */
function generateModels(workspaceRoot: string, backendName: string): void {
  execFileSync('npx', ['nx', 'run', `${backendName}:auth:generate`], {
    cwd: workspaceRoot,
    stdio: 'inherit',
  });
}
