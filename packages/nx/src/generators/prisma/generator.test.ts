import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson, writeJson } from '@nx/devkit';

import { changes, generatorTree } from '../../testing/generator-tree.ts';
import nodeAppGenerator from '../node-app/generator.ts';
import { appPackageVersions, zukhrufVersion } from '../versions.ts';
import prismaGenerator from './generator.ts';

test('writes a db package whose client is generated into src/prisma and not committed', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  const schema = tree.read('packages/db/schema.prisma', 'utf-8') ?? '';
  assert.match(schema, /provider\s+= "prisma-client"/);
  assert.match(schema, /output\s+= "src\/prisma"/);
  assert.match(schema, /importFileExtension = "ts"/);
  assert.match(schema, /datasource db \{\n\s+provider = "postgresql"\n\}/);
  const config = tree.read('packages/db/prisma.config.ts', 'utf-8') ?? '';
  assert.match(config, /schema: '\.'/);
  assert.match(config, /migrations: \{ path: 'migrations' \}/);
  assert.match(
    config,
    /url: process\.env\.CONNECTION_STRING \? env\('CONNECTION_STRING'\) : undefined/,
  );
  assert.match(
    config,
    /shadowDatabaseUrl: process\.env\.SHADOW_CONNECTION_STRING/,
  );
  assert.doesNotMatch(config, /dotenv/);
  assert.match(
    tree.read('packages/db/migrations/migration_lock.toml', 'utf-8') ?? '',
    /^provider = "postgresql"$/m,
  );
  assert.ok(tree.exists('packages/db/models/.gitkeep'));
  assert.match(
    tree.read('packages/db/src/index.ts', 'utf-8') ?? '',
    /new PrismaClient\(\{ adapter: new PrismaPg\(options\) \}\)/,
  );
  assert.match(
    tree.read('.gitignore', 'utf-8') ?? '',
    /^packages\/db\/src\/prisma$/m,
  );
  assert.match(
    tree.read('.prettierignore', 'utf-8') ?? '',
    /^packages\/db\/src\/prisma$/m,
  );
  const eslint = tree.read('packages/db/eslint.config.mjs', 'utf-8') ?? '';
  assert.match(eslint, /ignores: \['src\/prisma\/\*\*'\]/);
  assert.match(
    eslint,
    /allowDefaultProject: \['packages\/db\/prisma\.config\.ts'\]/,
  );
  assert.ok(!tree.exists('packages/db/project.json'));
});

test('the manifest exports the client and the test helper, and writes no Prisma target', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  const manifest = readJson(tree, 'packages/db/package.json');
  assert.equal(manifest.name, '@acme/db');
  assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.exports['.'], {
    development: './src/index.ts',
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  });
  assert.deepEqual(manifest.exports['./testing'], {
    development: './src/testing.ts',
    types: './dist/testing.d.ts',
    import: './dist/testing.js',
    default: './dist/testing.js',
  });
  assert.deepEqual(Object.keys(manifest.dependencies), [
    '@prisma/adapter-pg',
    '@prisma/client',
    'pg',
    'tslib',
  ]);
  assert.deepEqual(Object.keys(manifest.devDependencies), [
    '@types/pg',
    'prisma',
  ]);
  assert.deepEqual(manifest.nx.tags, ['test:docker']);
  assert.deepEqual(Object.keys(manifest.nx.targets), ['up', 'down']);
});

test('compose.dev.yml runs the image of the deployed stack on 127.0.0.1, at the port option, with a database of the scope', async () => {
  const tree = generatorTree('@meddit/source');

  await prismaGenerator(tree, { directory: 'packages/db', port: 5435 });

  const compose = tree.read('compose.dev.yml', 'utf-8') ?? '';
  assert.match(compose, /^ {4}image: postgres:18-alpine$/m);
  assert.match(compose, /^ {6}- '127\.0\.0\.1:5435:5432'$/m);
  assert.match(compose, /^ {6}POSTGRES_DB: meddit$/m);
  assert.match(compose, /^ {6}- database:\/var\/lib\/postgresql$/m);
  assert.match(compose, /pg_isready/);
  const url = 'postgresql://postgres:postgres@127.0.0.1:5435/meddit';
  for (const path of ['packages/db/.env.example', 'packages/db/.env']) {
    assert.match(
      tree.read(path, 'utf-8') ?? '',
      new RegExp(`^CONNECTION_STRING=${url}$`, 'm'),
    );
  }
});

test('the up target starts the local Postgres, waits for it, and migrates only it', async () => {
  const tree = generatorTree('@meddit/source');

  await prismaGenerator(tree, { directory: 'packages/db', port: 5435 });

  const { up, down } = readJson(tree, 'packages/db/package.json').nx.targets;
  assert.deepEqual(up, {
    executor: 'nx:run-commands',
    options: {
      commands: [
        'docker compose --file ../../compose.dev.yml up --detach --wait database',
        'prisma migrate deploy',
      ],
      parallel: false,
      cwd: '{projectRoot}',
      env: {
        CONNECTION_STRING:
          'postgresql://postgres:postgres@127.0.0.1:5435/meddit',
      },
    },
  });
  assert.deepEqual(down, {
    command: 'docker compose --file ../../compose.dev.yml down',
    options: { cwd: '{projectRoot}' },
  });
});

test('a compose.dev.yml that is there stays', async () => {
  const tree = generatorTree();
  const compose = 'services:\n  redis:\n    image: redis:8-alpine\n';
  tree.write('compose.dev.yml', compose);

  await prismaGenerator(tree, { directory: 'packages/db' });

  assert.equal(tree.read('compose.dev.yml', 'utf-8'), compose);
});

test('the Prisma CLI, client and adapter have one exact stable version', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  const { dependencies, devDependencies } = readJson(
    tree,
    'packages/db/package.json',
  );
  const written = [
    devDependencies.prisma,
    dependencies['@prisma/client'],
    dependencies['@prisma/adapter-pg'],
  ];
  assert.deepEqual(written, [
    appPackageVersions.prisma,
    appPackageVersions.prisma,
    appPackageVersions.prisma,
  ]);
  assert.match(appPackageVersions.prisma, /^\d+\.\d+\.\d+$/);
});

test('the test of the package applies the migrations to a database of @zukhruf/testing', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  const testFile = tree.read('packages/db/src/index.test.ts', 'utf-8') ?? '';
  assert.match(testFile, /from '@zukhruf\/testing\/postgres'/);
  assert.match(testFile, /from '\.\/index\.ts'/);
  assert.match(testFile, /from '\.\/testing\.ts'/);
  assert.match(
    testFile,
    /await using database = await postgres\.database\(\);/,
  );
  assert.match(testFile, /await applySchema\(database\.connectionString\);/);
  const testing = tree.read('packages/db/src/testing.ts', 'utf-8') ?? '';
  assert.match(
    testing,
    /resolve\(import\.meta\.dirname, '\.\.', 'migrations'\)/,
  );
  assert.match(testing, /'migration\.sql'/);
  assert.equal(
    readJson(tree, 'packages/db/tsconfig.lib.json').compilerOptions
      .rewriteRelativeImportExtensions,
    true,
  );
});

test('the migration image installs the CLI from the lockfile and runs migrate deploy', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  const dockerfile =
    tree.read('packages/db/Dockerfile.migration', 'utf-8') ?? '';
  assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7-labs$/m);
  assert.match(dockerfile, /^FROM node:lts-alpine$/m);
  assert.match(dockerfile, /^COPY --parents \*\*\/package\.json \.\/$/m);
  assert.match(dockerfile, /^RUN npm ci --workspace=@acme\/db /m);
  assert.match(dockerfile, /^WORKDIR \/workspace\/packages\/db$/m);
  assert.match(dockerfile, /^COPY packages\/db\/migrations \.\/migrations$/m);
  assert.match(dockerfile, /^CMD \["npx", "prisma", "migrate", "deploy"\]$/m);
  assert.doesNotMatch(dockerfile, /dotenv/);
  assert.ok(tree.exists('.dockerignore'));
});

test('nx.json lists the prisma plugin, and generate runs before typecheck and build', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });
  await prismaGenerator(tree, { directory: 'packages/db' });

  const { plugins, targetDefaults } = readJson(tree, 'nx.json');
  assert.equal(
    plugins.filter((entry: unknown) => entry === '@zukhruf/nx/prisma').length,
    1,
  );
  assert.deepEqual(targetDefaults.typecheck.dependsOn, [
    'lint',
    'format:check',
    '...',
    'generate',
  ]);
  assert.deepEqual(targetDefaults.build.dependsOn, ['generate', '...']);
});

test('the build default of a backend keeps ^sdk and gets generate', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  await prismaGenerator(tree, { directory: 'packages/db' });

  const { targetDefaults } = readJson(tree, 'nx.json');
  assert.deepEqual(targetDefaults.build.dependsOn, ['^sdk', 'generate', '...']);
  assert.deepEqual(targetDefaults.test.dependsOn, ['...', '^sdk']);
});

test('the root gets @zukhruf/testing and the install scripts of Prisma', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  const root = readJson(tree, 'package.json');
  assert.equal(root.devDependencies['@zukhruf/testing'], zukhrufVersion);
  assert.equal(root.allowScripts['@prisma/engines'], true);
  assert.equal(root.allowScripts.prisma, false);
  assert.equal(root.allowScripts.ssh2, false);
  assert.equal(root.allowScripts['cpu-features'], false);
  assert.ok(!('prisma' in root.devDependencies), 'the package holds the CLI');
});

test('a backend connects to the database before it serves and disconnects on SIGTERM', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  assert.match(
    tree.read('apps/backend/src/env.ts', 'utf-8') ?? '',
    /CONNECTION_STRING: z\.string\(\)\.min\(1\),/,
  );
  for (const path of ['apps/backend/.env.example', 'apps/backend/.env']) {
    assert.match(
      tree.read(path, 'utf-8') ?? '',
      /^CONNECTION_STRING=postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/acme$/m,
    );
  }
  const startup = tree.read('apps/backend/src/startup.ts', 'utf-8') ?? '';
  assert.match(startup, /^import '\.\/env\.ts';/);
  assert.match(startup, /import \{ createPrisma \} from '@acme\/db';/);
  assert.match(
    startup,
    /connectionString: process\.env\.CONNECTION_STRING,[\s\S]*await prisma\.\$queryRaw`SELECT 1`;/,
  );
  assert.doesNotMatch(startup, /export \{\};/);
  const server = tree.read('apps/backend/src/server.ts', 'utf-8') ?? '';
  assert.match(server, /import \{ prisma \} from '\.\/startup\.ts';/);
  assert.match(
    server,
    /async onSignal\(\) \{[\s\S]*await prisma\.\$disconnect\(\);\n\s+await flushLogs\(\);/,
  );
  const manifest = readJson(tree, 'apps/backend/package.json');
  assert.ok(!('@acme/db' in manifest.dependencies), 'the bundle inlines it');
  assert.deepEqual(
    {
      '@prisma/adapter-pg': manifest.dependencies['@prisma/adapter-pg'],
      '@prisma/client': manifest.dependencies['@prisma/client'],
      pg: manifest.dependencies.pg,
      tslib: manifest.dependencies.tslib,
    },
    readJson(tree, 'packages/db/package.json').dependencies,
  );
  assert.equal(manifest.nx.projectType, 'application');
  assert.deepEqual(manifest.nx.tags, ['test:docker']);
  const testFile =
    tree.read('apps/backend/src/database.test.ts', 'utf-8') ?? '';
  assert.match(testFile, /import \{ createPrisma \} from '@acme\/db';/);
  assert.match(testFile, /import \{ applySchema \} from '@acme\/db\/testing';/);
  assert.match(
    tree.read('apps/backend/src/routes/healthz.route.ts', 'utf-8') ?? '',
    /c\.json\(\{ status: 'ok', sha: process\.env\.BUILD_SHA \?\? null \}\)/,
  );
});

test("the backend's serve runs the up target of the db package it imports first", async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });

  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  assert.deepEqual(
    readJson(tree, 'apps/backend/package.json').nx.targets.serve,
    {
      dependsOn: ['^build', '^up'],
      options: { env: { NODE_ENV: 'development' } },
    },
  );
});

test('a second run with the backend adds nothing twice', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  const options = { directory: 'packages/db', backend: 'apps/backend' };
  await prismaGenerator(tree, options);
  const files = [
    'apps/backend/src/env.ts',
    'apps/backend/src/startup.ts',
    'apps/backend/src/server.ts',
    'apps/backend/.env.example',
    'apps/backend/package.json',
    '.gitignore',
    'nx.json',
  ];
  const first = files.map((path) => tree.read(path, 'utf-8'));

  await prismaGenerator(tree, options);

  assert.deepEqual(
    files.map((path) => tree.read(path, 'utf-8')),
    first,
  );
});

test('a .env of the backend with a CONNECTION_STRING keeps its value', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  const env = 'PORT=3000\nCONNECTION_STRING=postgresql://localhost/app\n';
  tree.write('apps/backend/.env', env);

  await prismaGenerator(tree, {
    directory: 'packages/db',
    backend: 'apps/backend',
  });

  assert.equal(tree.read('apps/backend/.env', 'utf-8'), env);
});

test('a db package with no backend changes no other project', async () => {
  const tree = generatorTree();
  await nodeAppGenerator(tree, { directory: 'apps/backend' });
  const backendFiles = [
    'src/env.ts',
    'src/startup.ts',
    'src/server.ts',
    'package.json',
  ].map((path) => `apps/backend/${path}`);
  const before = backendFiles.map((path) => tree.read(path, 'utf-8'));

  await prismaGenerator(tree, { directory: 'packages/db' });

  assert.deepEqual(
    backendFiles.map((path) => tree.read(path, 'utf-8')),
    before,
  );
  assert.ok(!tree.exists('apps/backend/src/database.test.ts'));
});

test('a workspace with no app gets no app folder', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'packages/db' });

  assert.deepEqual(
    [...changes(tree).keys()].filter((path) => path.startsWith('apps/')),
    [],
  );
});

test('a db package outside the workspace globs is added to workspaces', async () => {
  const tree = generatorTree();

  await prismaGenerator(tree, { directory: 'apps/v2/db' });

  assert.ok(readJson(tree, 'package.json').workspaces.includes('apps/v2/db'));
  assert.match(
    tree.read('apps/v2/db/eslint.config.mjs', 'utf-8') ?? '',
    /from '\.\.\/\.\.\/\.\.\/eslint\.config\.mjs'/,
  );
});

test('a second run keeps the files of the package', async () => {
  const tree = generatorTree();
  await prismaGenerator(tree, { directory: 'packages/db' });
  const schema = `${tree.read('packages/db/schema.prisma', 'utf-8')}// edited\n`;
  tree.write('packages/db/schema.prisma', schema);

  await prismaGenerator(tree, { directory: 'packages/db' });

  assert.equal(tree.read('packages/db/schema.prisma', 'utf-8'), schema);
});

test('a folder of another package stops the generator', async () => {
  const tree = generatorTree();
  writeJson(tree, 'packages/db/package.json', { name: '@acme/other' });

  await assert.rejects(prismaGenerator(tree, { directory: 'packages/db' }), {
    message: 'packages/db already belongs to @acme/other.',
  });
});

test('a backend that is not a node-app stops the generator', async () => {
  const tree = generatorTree();

  await assert.rejects(
    prismaGenerator(tree, { directory: 'packages/db', backend: 'apps/api' }),
    {
      message:
        'apps/api has no sdk-it.config.ts, so it is not a node-app. Run @zukhruf/nx:node-app apps/api first.',
    },
  );
});
