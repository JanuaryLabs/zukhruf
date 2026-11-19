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
import { envMarker, infraRoot } from '../dokploy/files.ts';
import initGenerator from '../init/generator.ts';
import { uiMountComment, uiRouteImport } from '../pair/files.ts';
import { portOf } from '../pair/generator.ts';
import {
  rootDependencyNames,
  settleRootDependencies,
} from '../root-dependencies.ts';
import { appPackageVersions as versions, zukhrufVersion } from '../versions.ts';
import {
  allowedOriginsComment,
  authCliTs,
  authClientTs,
  authEnvTs,
  authMount,
  authPrisma,
  authRouteTs,
  authStackEnv,
  authTf,
  authTs,
  backendSessionTs,
  startupAuthTs,
  webSessionTs,
} from './files.ts';

export interface AuthOptions {
  /** The project root of a node-app that a db package is wired into, for example `apps/backend`. */
  backend: string;
  /** The project root of the db package of the prisma generator, for example `packages/db`. */
  db: string;
  /** The project root of a react-app that reaches this backend through `/api`, for example `apps/web`. */
  web?: string;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  nx?: { targets?: Record<string, unknown> };
}

/** The origin of the Vite dev server of a react-app (its vite.config.ts). */
const viteOrigin = 'http://localhost:5173';

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
  const webRoot =
    options.web === undefined
      ? undefined
      : appDirectory(options.web).projectRoot;
  if (webRoot !== undefined && !tree.exists(`${webRoot}/vite.config.ts`)) {
    throw new Error(
      `${webRoot} has no vite.config.ts, so it is not a react-app. Run @zukhruf/nx:react-app ${webRoot} first.`,
    );
  }
  const backendName = projectNameOf(tree, backendRoot);
  const dbName = projectNameOf(tree, dbRoot);
  const before = rootDependencyNames(tree);

  writeIfMissing(tree, `${backendRoot}/src/auth.ts`, authTs(dbPackageName));
  writeIfMissing(tree, `${backendRoot}/${cliConfig}`, authCliTs(dbPackageName));
  writeIfMissing(tree, `${backendRoot}/src/routes/auth.route.ts`, authRouteTs);
  writeIfMissing(tree, `${backendRoot}/src/session.ts`, backendSessionTs);
  writeIfMissing(tree, `${dbRoot}/models/auth.prisma`, authPrisma);
  wireStartup(tree, startupPath, dbPackageName);
  mountRoutes(tree, `${backendRoot}/src/app.ts`);
  wireEnvironment(tree, backendRoot);
  wireInfra(tree);
  if (webRoot !== undefined) wireWeb(tree, backendRoot, webRoot);
  updateJson(
    tree,
    `${backendRoot}/package.json`,
    (packageJson: PackageJson) => {
      packageJson.dependencies = {
        ...packageJson.dependencies,
        'better-auth': versions['better-auth'],
        '@zukhruf/authentication': zukhrufVersion,
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
  const marker = !app.includes(uiRouteImport)
    ? '\napp.notFound((c) =>'
    : app.includes(uiMountComment)
      ? `\n${uiMountComment}`
      : '\n// pair fixed the path of the web build';
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

/**
 * When the dokploy generator wrote the infra, the module call in its main.tf
 * gets the secret and the URL above the marker of its env map, and auth.tf the
 * secret (ADR 0015 decision 6). A repo without the module call gets nothing.
 */
function wireInfra(tree: Tree): void {
  const production = `${infraRoot}/src/environments/production`;
  const mainPath = `${production}/main.tf`;
  const main = tree.read(mainPath, 'utf-8');
  if (main === null || !/^module "stack" \{$/m.test(main)) return;
  if (!/^\s*BETTER_AUTH_SECRET\s*=/m.test(main)) {
    if (!main.includes(envMarker)) {
      throw new Error(
        `${mainPath} calls module "stack" but its env has no ${JSON.stringify(envMarker)}, so the generator cannot add BETTER_AUTH_SECRET = random_password.better_auth.result and BETTER_AUTH_URL = "https://\${local.host}". Add the two lines to env, or put the marker back as the last line of env.`,
      );
    }
    tree.write(
      mainPath,
      main.replace(envMarker, `${authStackEnv}${envMarker}`),
    );
  }
  writeIfMissing(tree, `${production}/auth.tf`, authTf);
}

/**
 * The web app gets the client, and the backend trusts the origins that the
 * browser sends in development. The Vite proxy keeps the Origin of the page
 * (changeOrigin: false), so better-auth sees the origin of the web app, not
 * BETTER_AUTH_URL.
 */
function wireWeb(tree: Tree, backendRoot: string, webRoot: string): void {
  writeIfMissing(tree, `${webRoot}/src/auth-client.ts`, authClientTs);
  writeIfMissing(tree, `${webRoot}/src/session.ts`, webSessionTs);
  updateJson(tree, `${webRoot}/package.json`, (packageJson: PackageJson) => {
    const reactRouter = packageJson.dependencies?.['react-router'];
    packageJson.dependencies = {
      ...packageJson.dependencies,
      'better-auth': versions['better-auth'],
      '@zukhruf/authentication': zukhrufVersion,
      // npm refuses a react-router below the peer range of
      // @zukhruf/authentication (ERESOLVE). A newer one stays.
      'react-router':
        reactRouter !== undefined &&
        !isBelow(reactRouter, versions['react-router'])
          ? reactRouter
          : versions['react-router'],
    };
    return packageJson;
  });
  const origins = [viteOrigin];
  const portless = portlessOrigin(tree, webRoot);
  if (portless !== undefined) origins.push(portless);
  for (const file of ['.env.example', '.env']) {
    const path = `${backendRoot}/${file}`;
    if (tree.exists(path)) addAllowedOrigins(tree, path, origins);
  }
}

/**
 * Whether the version that a range like `8.5.1` or `^8.5.1` starts at is below
 * `version`. A range that names no version is below.
 */
function isBelow(range: string, version: string): boolean {
  const parts = (text: string) =>
    /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
  const [from, to] = [parts(range), parts(version)];
  if (from === undefined || to === undefined) return true;
  const index = from.findIndex((part, i) => part !== to[i]);
  return index !== -1 && (from[index] ?? 0) < (to[index] ?? 0);
}

/**
 * The origin of the portless target of the web app: portless serves
 * `--name <name>` at https://<name>.localhost by default.
 */
function portlessOrigin(tree: Tree, webRoot: string): string | undefined {
  const { nx } = readJson<{
    nx?: { targets?: { portless?: { command?: string } } };
  }>(tree, `${webRoot}/package.json`);
  const command = nx?.targets?.portless?.command ?? '';
  const name = /--name (\S+)/.exec(command)?.[1];
  return name === undefined ? undefined : `https://${name}.localhost`;
}

/** Adds each missing origin to the ALLOWED_ORIGINS list of an env file. */
function addAllowedOrigins(tree: Tree, path: string, origins: string[]): void {
  const content = tree.read(path, 'utf-8') ?? '';
  const line = /^ALLOWED_ORIGINS=(.*)$/m.exec(content);
  if (line === null) {
    const separator = content === '' || content.endsWith('\n') ? '' : '\n';
    tree.write(
      path,
      `${content}${separator}${allowedOriginsComment}ALLOWED_ORIGINS=${origins.join(',')}\n`,
    );
    return;
  }
  const [whole, list = ''] = line;
  const listed = list
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  const missing = origins.filter((origin) => !listed.includes(origin));
  if (missing.length === 0) return;
  const comment = content.includes(allowedOriginsComment)
    ? ''
    : allowedOriginsComment;
  tree.write(
    path,
    content.replace(
      whole,
      `${comment}ALLOWED_ORIGINS=${[...listed, ...missing].join(',')}`,
    ),
  );
}

interface TargetOptions {
  backendRoot: string;
  dbRoot: string;
  dbName: string;
}

/**
 * The CLI imports the db package through its development export, which
 * imports the generated client, so the client is generated first. NODE_OPTIONS
 * gives jiti the development condition. NODE_ENV is production, as in every
 * setup: auth.cli.ts passes a secret of its own, so better-auth never meets
 * its default secret, which it refuses under production. auth:check only reads: it
 * compares the generated client with the plugins of the config, and exits 1 on
 * a mismatch.
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
      NODE_ENV: 'production',
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
