import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson } from '@nx/devkit';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import prismaGenerator from '../prisma/generator.ts';
import { appPackageVersions } from '../versions.ts';
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

test('startup.ts builds the auth on the app client, and app.ts serves it before the UI and notFound', async () => {
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
      "\n// pair fixed the path of the web build; development enters through the Vite proxy.\n(await import('./routes/ui.route.ts')).default(app);\n\napp.notFound((c) =>",
    ),
  );

  await authGenerator(tree, options);

  const startup = tree.read('apps/backend/src/startup.ts', 'utf-8') ?? '';
  assert.match(startup, /import \{ createAuth \} from '\.\/auth\.ts';/);
  assert.match(
    startup,
    /export const prisma = createPrisma[\s\S]*export const auth = createAuth\(\{\n\s+prisma,\n\s+secret: process\.env\.BETTER_AUTH_SECRET,\n\s+baseURL: process\.env\.BETTER_AUTH_URL,\n\s+trustedOrigins: process\.env\.ALLOWED_ORIGINS\.split\(','\)/,
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
        NODE_ENV: 'development',
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
        NODE_ENV: 'development',
      },
      command: 'npx auth check schema --config src/auth.cli.ts',
    },
  });
});
