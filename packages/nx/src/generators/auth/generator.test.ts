import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Tree, readJson } from '@nx/devkit';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import { lintManifests } from '../../testing/lint-manifests.ts';
import { lintNodeEnv } from '../../testing/lint-node-env.ts';
import { stackModuleSource } from '../dokploy/files.ts';
import dokployGenerator from '../dokploy/generator.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import { legacyUiMount, uiMount } from '../pair/files.ts';
import pairGenerator from '../pair/generator.ts';
import prismaGenerator from '../prisma/generator.ts';
import reactAppGenerator from '../react-app/generator.ts';
import { appPackageVersions, zukhrufVersion } from '../versions.ts';
import authGenerator from './generator.ts';

const options = { backend: 'apps/backend', db: 'packages/db' };

test('a backend that is not a node-app stops the generator', async () => {
  const tree = generatorTree();
  await prismaGenerator(tree, { directory: 'packages/db' });

  await assert.rejects(
    authGenerator(tree, { backend: 'apps/api', db: 'packages/db' }),
    {
      message:
        'apps/api has no sdk-it.config.ts, so it is not a node-app. Run @zukhruf/nx:node-app apps/api first.',
    },
  );
});

test('a db that is not a db package of the prisma generator stops the generator', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  await assert.rejects(
    authGenerator(tree, { backend: 'apps/backend', db: 'packages/db' }),
    {
      message:
        'packages/db has no prisma.config.ts and createPrisma, so it is not a db package. Run @zukhruf/nx:prisma packages/db first.',
    },
  );
});

test('a backend that the db package is not wired into stops the generator', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, { directory: 'packages/db' });

  await assert.rejects(authGenerator(tree, options), {
    message:
      'apps/backend/src/startup.ts does not create the client of @acme/db. Run @zukhruf/nx:prisma packages/db --backend apps/backend first.',
  });
});

test('a second run adds nothing twice and keeps the secret of .env', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await authGenerator(tree, options);
  const files = [
    'apps/backend/src/app.ts',
    'apps/backend/src/env.ts',
    'apps/backend/src/startup.ts',
    'apps/backend/src/session.ts',
    'apps/backend/.env',
    'apps/backend/.env.example',
    'apps/backend/package.json',
    'packages/db/models/auth.prisma',
    'package.json',
  ];
  const first = files.map((path) => tree.read(path, 'utf-8'));

  await authGenerator(tree, options);

  assert.deepEqual(
    files.map((path) => tree.read(path, 'utf-8')),
    first,
  );
});

test('a .env of the backend with auth values keeps them', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  const env =
    'PORT=3000\nCONNECTION_STRING=postgresql://localhost/app\nBETTER_AUTH_SECRET=mine-mine-mine-mine-mine-mine-mine\nBETTER_AUTH_URL=https://api.example.com\n';
  tree.write('apps/backend/.env', env);

  await authGenerator(tree, options);

  assert.equal(tree.read('apps/backend/.env', 'utf-8'), env);
});

test('the factory and the CLI config load no env.ts and no startup.ts', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const auth = tree.read('apps/backend/src/auth.ts', 'utf-8') ?? '';
  assert.match(auth, /export function createAuth\(options: AuthOptions\)/);
  assert.match(
    auth,
    /database: prismaAdapter\(options\.prisma, \{ provider: 'postgresql' \}\)/,
  );
  assert.match(auth, /emailAndPassword: \{ enabled: true \}/);
  assert.match(auth, /import type \{ PrismaClient \} from '@acme\/db';/);
  assert.doesNotMatch(auth, /process\.env|env\.ts'|startup\.ts'/);
  const cli = tree.read('apps/backend/src/auth.cli.ts', 'utf-8') ?? '';
  assert.match(cli, /^export const auth = createAuth\(\{/m);
  assert.match(
    cli,
    /createPrisma\(\{\n\s+connectionString: process\.env\.CONNECTION_STRING \?\? '',\n\s+\}\)/,
  );
  assert.match(cli, /import \{ createAuth \} from '\.\/auth\.ts';/);
  assert.doesNotMatch(cli, /env\.ts'|startup\.ts'/);
});

void test.each(
  [
    [uiMount, 'the UI_ROOT mount'],
    [legacyUiMount, 'the mount before UI_ROOT'],
  ] as const,
  ([mount, version]) =>
    test(`app.ts serves the auth routes before ${version} of pair`, async () => {
      const tree = generatorTree();
      await nodeAppGenerator(tree, { directory: 'apps/backend' });
      await prismaGenerator(tree, {
        directory: 'packages/db',
        backend: 'apps/backend',
      });
      tree.write(
        'apps/backend/src/app.ts',
        (tree.read('apps/backend/src/app.ts', 'utf-8') ?? '').replace(
          '\napp.notFound((c) =>',
          `\n${mount}\n\napp.notFound((c) =>`,
        ),
      );

      await authGenerator(tree, options);

      const app = tree.read('apps/backend/src/app.ts', 'utf-8') ?? '';
      assert.ok(
        app.includes(
          `// better-auth answers under /api/auth.\n(await import('./routes/auth.route.ts')).default(app);\n\n${mount}\n`,
        ),
        app,
      );
    }),
);

test('startup.ts builds the auth on the app client, and app.ts serves it before the UI and notFound', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const startup = tree.read('apps/backend/src/startup.ts', 'utf-8') ?? '';
  assert.match(startup, /import \{ createAuth \} from '\.\/auth\.ts';/);
  assert.match(
    startup,
    /export const prisma = createPrisma[\s\S]*const allowedOrigins = process\.env\.ALLOWED_ORIGINS\.split\(','\)[\s\S]*export const auth = createAuth\(\{\n\s+prisma,\n\s+secret: process\.env\.BETTER_AUTH_SECRET,[\s\S]*trustedOrigins: allowedOrigins,\n\}\);/,
  );
  const route =
    tree.read('apps/backend/src/routes/auth.route.ts', 'utf-8') ?? '';
  assert.match(
    route,
    /app\.on\(\['POST', 'GET'\], '\/api\/auth\/\*', async \(c\) => \{\n\s+const \{ auth \} = await import\('\.\.\/startup\.ts'\);\n\s+return auth\.handler\(c\.req\.raw\);/,
  );
  assert.doesNotMatch(route, /^import (?!type).*startup/m);
  const app = tree.read('apps/backend/src/app.ts', 'utf-8') ?? '';
  const mount = app.indexOf(
    "(await import('./routes/auth.route.ts')).default(app);",
  );
  assert.ok(mount > 0);
  assert.ok(mount < app.indexOf("import('./routes/ui.route.ts')"));
  assert.ok(mount < app.indexOf('app.notFound('));
  assert.doesNotMatch(app, /startup\.ts/);
});

test('env.ts declares the secret and the URL, and .env gets a random secret of its own', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend', port: 3100 });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const env = tree.read('apps/backend/src/env.ts', 'utf-8') ?? '';
  assert.match(env, /BETTER_AUTH_SECRET: z\.string\(\)\.min\(32\),/);
  assert.match(env, /BETTER_AUTH_URL: z\.url\(\),/);
  const example = tree.read('apps/backend/.env.example', 'utf-8') ?? '';
  assert.match(example, /^BETTER_AUTH_SECRET=$/m);
  assert.match(example, /^BETTER_AUTH_URL=http:\/\/localhost:3100$/m);
  const dotenv = tree.read('apps/backend/.env', 'utf-8') ?? '';
  const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(dotenv)?.[1] ?? '';
  assert.match(secret, /^[\w-]{43}$/);
  assert.match(dotenv, /^BETTER_AUTH_URL=http:\/\/localhost:3100$/m);
  const other = generatorTree();
  await nodeAppGenerator(other, { directory: 'apps/backend' });
  await prismaGenerator(other, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await authGenerator(other, options);
  assert.notEqual(
    /^BETTER_AUTH_SECRET=(.*)$/m.exec(
      tree.read('apps/backend/.env', 'utf-8') ?? '',
    )?.[1],
    /^BETTER_AUTH_SECRET=(.*)$/m.exec(
      other.read('apps/backend/.env', 'utf-8') ?? '',
    )?.[1],
  );
});

test('better-auth and its CLI have one exact version', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const backend = readJson(tree, 'apps/backend/package.json');
  const root = readJson(tree, 'package.json');
  assert.deepEqual(
    [backend.dependencies['better-auth'], root.devDependencies.auth],
    ['1.7.26', '1.7.26'],
  );
  assert.equal(appPackageVersions['better-auth'], appPackageVersions.auth);
});

test('the db package gets a placeholder of the models and no migration', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  const before = new Set(changes(tree).keys());

  await authGenerator(tree, options);

  const models = tree.read('packages/db/models/auth.prisma', 'utf-8') ?? '';
  assert.match(models, /^\/\/ .*\n$/);
  assert.doesNotMatch(models, /generator|datasource/);
  assert.deepEqual(
    [...changes(tree).keys()].filter(
      (path) => path.startsWith('packages/db/') && !before.has(path),
    ),
    ['packages/db/models/auth.prisma'],
  );
});

test('auth:generate and auth:check run the CLI on a generated client, with the development condition', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const { targets } = readJson(tree, 'apps/backend/package.json').nx;
  const generateClient = ['^generate'];
  assert.deepEqual(targets['auth:generate'], {
    executor: 'nx:run-commands',
    dependsOn: generateClient,
    options: {
      cwd: '{projectRoot}',
      env: {
        NODE_OPTIONS: '--conditions=development',
        NODE_ENV: 'production',
      },
      commands: [
        'npx auth generate --adapter prisma --config src/auth.cli.ts --output ../../packages/db/models/auth.prisma --yes',
        'npx nx run @acme/db:generate',
      ],
      parallel: false,
    },
  });
  assert.deepEqual(targets['auth:check'], {
    executor: 'nx:run-commands',
    dependsOn: generateClient,
    options: {
      cwd: '{projectRoot}',
      env: {
        NODE_OPTIONS: '--conditions=development',
        NODE_ENV: 'production',
      },
      command: 'npx auth check schema --config src/auth.cli.ts',
    },
  });
});

test('a web that is not a react-app stops the generator', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await assert.rejects(authGenerator(tree, { ...options, web: 'apps/web' }), {
    message:
      'apps/web has no vite.config.ts, so it is not a react-app. Run @zukhruf/nx:react-app apps/web first.',
  });
});

test('the web gets a client on its own origin and an exact better-auth', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, { ...options, web: 'apps/web' });

  const client = tree.read('apps/web/src/auth-client.ts', 'utf-8') ?? '';
  assert.match(
    client,
    /^import \{ createAuthClient \} from 'better-auth\/react';$/m,
  );
  assert.match(client, /^export const authClient = createAuthClient\(\);$/m);
  assert.equal(
    readJson(tree, 'apps/web/package.json').dependencies['better-auth'],
    appPackageVersions['better-auth'],
  );
});

test('the backend trusts the origins of the Vite dev server and portless, and keeps its own', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  tree.write(
    'apps/backend/.env',
    `${tree.read('apps/backend/.env', 'utf-8')}`.replace(
      /^ALLOWED_ORIGINS=.*$/m,
      'ALLOWED_ORIGINS=https://admin.example.com',
    ),
  );

  await authGenerator(tree, { ...options, web: 'apps/web' });

  assert.match(
    tree.read('apps/backend/.env.example', 'utf-8') ?? '',
    /^ALLOWED_ORIGINS=http:\/\/localhost:5173,https:\/\/web\.acme\.localhost$/m,
  );
  assert.match(
    tree.read('apps/backend/.env', 'utf-8') ?? '',
    /^ALLOWED_ORIGINS=https:\/\/admin\.example\.com,http:\/\/localhost:5173,https:\/\/web\.acme\.localhost$/m,
  );
});

test('a second run with a web adds nothing twice', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await authGenerator(tree, { ...options, web: 'apps/web' });
  const files = [
    'apps/backend/.env',
    'apps/backend/.env.example',
    'apps/web/package.json',
    'apps/web/src/auth-client.ts',
    'apps/web/src/session.ts',
  ];
  const first = files.map((path) => tree.read(path, 'utf-8'));

  await authGenerator(tree, { ...options, web: 'apps/web' });

  assert.deepEqual(
    files.map((path) => tree.read(path, 'utf-8')),
    first,
  );
});

test('the backend gets a session middleware that loads startup.ts only on a request', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const session = tree.read('apps/backend/src/session.ts', 'utf-8') ?? '';
  assert.match(
    session,
    /^import \{ requireSession \} from '@zukhruf\/authentication\/hono';$/m,
  );
  assert.match(session, /^import type \{ auth \} from '\.\/startup\.ts';$/m);
  assert.doesNotMatch(session, /^import (?!type).*startup/m);
  assert.match(
    session,
    /async getSession\(context: \{\n\s+headers: Headers;\n\s+\}\): Promise<typeof auth\.\$Infer\.Session \| null> \{\n\s+const startup = await import\('\.\/startup\.ts'\);\n\s+return startup\.auth\.api\.getSession\(context\);/,
  );
  assert.match(
    session,
    /^export const signedIn = requireSession\(sessions\);$/m,
  );
  assert.equal(
    readJson(tree, 'apps/backend/package.json').dependencies[
      '@zukhruf/authentication'
    ],
    zukhrufVersion,
  );
});

test('the web gets a loader guard on its client, with the paths left to the host', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, { ...options, web: 'apps/web' });

  const session = tree.read('apps/web/src/session.ts', 'utf-8') ?? '';
  assert.match(session, /from '@zukhruf\/authentication\/react-router';/);
  assert.match(
    session,
    /^import \{ authClient \} from '\.\/auth-client\.ts';$/m,
  );
  assert.match(
    session,
    /export function signedInLoader\(\n\s+options: RequireSessionOptions<typeof authClient\.\$Infer\.Session>,\n\) \{\n\s+return \(\{ request \}: LoaderFunctionArgs\) =>\n\s+requireSession\(authClient, request, options\);/,
  );
  assert.doesNotMatch(session, /twoFactorSetup|'\/sign-in'/);
  assert.equal(
    readJson(tree, 'apps/web/package.json').dependencies[
      '@zukhruf/authentication'
    ],
    zukhrufVersion,
  );
});

test('the web gets the react-router that @zukhruf/authentication peers on, and keeps a newer one', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  const withReactRouter = (version: string) => {
    const manifest = readJson(tree, 'apps/web/package.json');
    manifest.dependencies['react-router'] = version;
    tree.write('apps/web/package.json', JSON.stringify(manifest));
  };
  const reactRouter = () =>
    readJson(tree, 'apps/web/package.json').dependencies['react-router'];

  withReactRouter('8.5.1');
  await authGenerator(tree, { ...options, web: 'apps/web' });
  const raised = reactRouter();
  withReactRouter('8.10.0');
  await authGenerator(tree, { ...options, web: 'apps/web' });

  assert.deepEqual([raised, reactRouter()], ['8.5.2', '8.10.0']);
  assert.equal(appPackageVersions['react-router'], '8.5.2');
});

test('a session module that the host changed stays as it is', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await authGenerator(tree, { ...options, web: 'apps/web' });
  const mine = 'export const mine = 1;\n';
  tree.write('apps/backend/src/session.ts', mine);
  tree.write('apps/web/src/session.ts', mine);

  await authGenerator(tree, { ...options, web: 'apps/web' });

  assert.deepEqual(
    [
      tree.read('apps/backend/src/session.ts', 'utf-8'),
      tree.read('apps/web/src/session.ts', 'utf-8'),
    ],
    [mine, mine],
  );
});

test('in every setup, better-auth builds its links on the host of an allowed origin, and on BETTER_AUTH_URL for any other host', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const startup = tree.read('apps/backend/src/startup.ts', 'utf-8') ?? '';
  assert.match(
    startup,
    /^ {2}baseURL: \{\n {4}fallback: process\.env\.BETTER_AUTH_URL,\n {4}allowedHosts: allowedOrigins\.map\(\(origin\) => new URL\(origin\)\.host\),\n {2}\},$/m,
  );
  assert.doesNotMatch(startup, /NODE_ENV/);
  const auth = tree.read('apps/backend/src/auth.ts', 'utf-8') ?? '';
  assert.match(
    auth,
    /baseURL: \{ fallback: string; allowedHosts: string\[\] \};/,
  );
  assert.match(auth, /advanced: \{ trustedProxyHeaders: true \}/);
});

test('the CLI config passes a throwaway secret of 32 characters or more', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  const cli = tree.read('apps/backend/src/auth.cli.ts', 'utf-8') ?? '';
  assert.match(
    cli,
    /^ {2}\/\/ A throwaway secret of 32\+ characters: the CLI only reads the schema\.\n {2}secret: '[^']{32,}',$/m,
  );
  assert.match(
    cli,
    /baseURL: \{ fallback: 'http:\/\/localhost', allowedHosts: \['localhost'\] \},/,
  );
});

const production = 'infra/src/environments/production';

/** A backend wired to a db package and delivered by the dokploy generator. */
async function deliveredWorkspace(): Promise<Tree> {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  await dokployGenerator(tree, {
    api: 'apps/backend',
    owner: 'acme',
    database: 'packages/db',
  });
  return tree;
}

test('with the infra of the dokploy generator, the module call gets the secret and the URL above the marker of its env, and auth.tf the secret', async () => {
  const tree = await deliveredWorkspace();

  await authGenerator(tree, options);

  assert.match(
    tree.read(`${production}/main.tf`, 'utf-8') ?? '',
    /\n {2}env = \{\n {4}PUBLIC_HOST {5}= local\.host\n {4}ALLOWED_ORIGINS = "https:\/\/\$\{local\.host\}"\n {4}# better-auth signs the session cookies with the secret, and builds its links on the URL\.\n {4}BETTER_AUTH_SECRET = random_password\.better_auth\.result\n {4}BETTER_AUTH_URL {4}= "https:\/\/\$\{local\.host\}"\n {4}# Generators add env keys above this line\.\n {2}\}\n\}\n/,
  );
  assert.match(
    tree.read(`${production}/auth.tf`, 'utf-8') ?? '',
    /^resource "random_password" "better_auth" \{\n {2}length {2}= 64\n {2}special = false\n\n {2}lifecycle \{\n {4}prevent_destroy = true\n {2}\}\n\}\n/m,
  );
});

test('a second run changes no file of infra/, and keeps an auth.tf that the repo edited', async () => {
  const tree = await deliveredWorkspace();
  await authGenerator(tree, options);
  tree.write(
    `${production}/auth.tf`,
    (tree.read(`${production}/auth.tf`, 'utf-8') ?? '').replace(
      'length  = 64',
      'length  = 48',
    ),
  );
  const infra = () =>
    [...changes(tree)].filter(([path]) => path.startsWith('infra/'));
  const first = infra();

  await authGenerator(tree, options);

  assert.deepEqual(infra(), first);
  assert.match(
    tree.read(`${production}/auth.tf`, 'utf-8') ?? '',
    /length {2}= 48/,
  );
});

test('a module call whose env lost the marker stops the generator with the two lines to add', async () => {
  const tree = await deliveredWorkspace();
  tree.write(
    `${production}/main.tf`,
    (tree.read(`${production}/main.tf`, 'utf-8') ?? '').replace(
      '    # Generators add env keys above this line.\n',
      '',
    ),
  );

  await assert.rejects(authGenerator(tree, options), {
    message:
      'infra/src/environments/production/main.tf calls module "stack" but its env has no "# Generators add env keys above this line.", so the generator cannot add BETTER_AUTH_SECRET = random_password.better_auth.result and BETTER_AUTH_URL = "https://${local.host}". Add the two lines to env, or put the marker back as the last line of env.',
  });
});

test('a repo without the infra of the dokploy generator gets no file in infra/', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, options);

  assert.deepEqual(
    [...changes(tree).keys()].filter((path) => path.startsWith('infra/')),
    [],
  );
});

test('a main.tf that does not call module "stack" stays as it is, and gets no auth.tf beside it', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });
  const main =
    'resource "dokploy_compose" "backend" {\n  env = <<-EOT\n    PUBLIC_HOST=example.com\n  EOT\n}\n';
  tree.write(`${production}/main.tf`, main);

  await authGenerator(tree, options);

  assert.equal(tree.read(`${production}/main.tf`, 'utf-8'), main);
  assert.equal(tree.exists(`${production}/auth.tf`), false);
});

// The host's format:check runs tofu fmt -check and its typecheck tofu validate,
// so the lines that auth adds must pass both beside the dokploy generator's.
// The module call points at the module of the checkout, as in the dokploy
// tests. Copy of the dokploy generator test (strike 2, #4733).
const tofuOnPath =
  spawnSync('tofu', ['version'], { stdio: 'ignore' }).status === 0;

test(
  'the infra with the auth lines is formatted and validates against the dokploy-stack module of the checkout',
  { skip: tofuOnPath ? false : 'tofu is not on PATH' },
  async () => {
    const tree = await deliveredWorkspace();
    await authGenerator(tree, options);
    await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
    await cp(
      fileURLToPath(
        new URL('../../../opentofu/dokploy-stack', import.meta.url),
      ),
      join(folder.path, 'dokploy-stack'),
      { recursive: true, filter: (source) => !source.includes('.terraform') },
    );
    for (const change of tree.listChanges()) {
      if (change.type === 'DELETE' || !change.path.startsWith('infra/')) {
        continue;
      }
      const path = join(folder.path, change.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        (change.content?.toString() ?? '').replace(
          stackModuleSource,
          '../../../../dokploy-stack',
        ),
      );
    }

    for (const args of [
      ['fmt', '-check', '-diff', '-recursive'],
      ['init', '-backend=false', '-input=false', '-lockfile=readonly'],
      ['validate', '-no-color'],
    ]) {
      const run = spawnSync('tofu', args, {
        cwd: join(folder.path, production),
        encoding: 'utf8',
      });

      assert.equal(
        run.status,
        0,
        `tofu ${args.join(' ')}\n${run.stdout}${run.stderr}`,
      );
    }
  },
);

test('what auth writes lints clean under @zukhruf/eslint', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, { ...options, web: 'apps/web' });

  assert.deepEqual(await lintManifests(tree), []);
});

test('the code that auth writes reads no NODE_ENV', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  await reactAppGenerator(tree, { directory: 'apps/web' });
  await pairGenerator(tree, { api: 'apps/backend', web: 'apps/web' });
  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  await authGenerator(tree, { ...options, web: 'apps/web' });

  assert.deepEqual(await lintNodeEnv(tree), []);
});
