import assert from 'node:assert/strict';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TemporaryFiles } from '@zukhruf/fs';

import { workspace as temporaryWorkspace } from '../testing/workspace.ts';

const pluginEntry = fileURLToPath(import.meta.resolve('@zukhruf/nx/prisma'));

interface Target {
  options: { command: string; cwd: string };
  cache?: boolean;
  inputs?: unknown[];
  outputs?: string[];
  dependsOn?: string[];
}

// A `prisma` on the PATH of the tasks that logs each call to `prisma.log` in
// the workspace root; `generate` writes a client into `src/prisma`, as the
// generator block of `schema` below says.
const fakePrisma = (root: string) => `#!/bin/sh
echo "prisma $*" >> "${root}/prisma.log"
if [ "$1" = generate ]; then mkdir -p src/prisma && echo client > src/prisma/client.ts; fi
`;

const installed = {
  'node_modules/prisma': { version: '7.10.1', license: 'Apache-2.0' },
  'node_modules/@prisma/client': { version: '7.10.1', license: 'Apache-2.0' },
};

// Nx linked from zukhruf, `prisma` and `@prisma/client` in the lockfile, the
// fake `prisma`, and the plugin entry in `nx.json`.
async function workspace(root: string, files: Record<string, string>) {
  const probe = await temporaryWorkspace<Target>({
    root,
    files: { ...files, 'node_modules/.bin/prisma': fakePrisma(root) },
    plugins: [pluginEntry],
    links: ['nx'],
    packages: installed,
  });
  await chmod(join(root, 'node_modules/.bin/prisma'), 0o755);
  return probe;
}

const projectJson = (name: string) => `{ "name": "${name}" }\n`;
const prismaConfig =
  "import { defineConfig } from 'prisma/config';\n\nexport default defineConfig({ schema: '.' });\n";
const schema = (output?: string) =>
  `generator client {\n  provider = "prisma-client"\n${output === undefined ? '' : `  output   = "${output}"\n`}}\n\ndatasource db {\n  provider = "postgresql"\n}\n`;
const model = 'model User {\n  id Int @id\n}\n';

test('a project with prisma.config.ts gets generate, migrate, migrate:check, migrate:create, deploy, reset and pull', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/db/project.json': projectJson('db'),
    'packages/db/prisma.config.ts': prismaConfig,
    'packages/db/schema.prisma': schema('src/prisma'),
    'packages/db/models/user.prisma': model,
  });

  const targets = await probe.targets('db');

  const cwd = 'packages/db';
  assert.partialDeepStrictEqual(targets, {
    generate: {
      options: { command: 'prisma generate', cwd },
      cache: true,
      inputs: [
        '{projectRoot}/**/*.prisma',
        '{projectRoot}/prisma.config.ts',
        { externalDependencies: ['prisma', '@prisma/client'] },
      ],
      outputs: ['{projectRoot}/src/prisma'],
    },
    migrate: {
      options: { command: 'prisma migrate dev', cwd },
      dependsOn: ['generate'],
    },
    'migrate:check': {
      options: { cwd },
      cache: true,
      inputs: [
        '{projectRoot}/**/*.prisma',
        '{projectRoot}/prisma.config.ts',
        '{projectRoot}/migrations/**/*',
        { externalDependencies: ['prisma'] },
      ],
    },
    'migrate:create': { options: { cwd } },
    deploy: { options: { command: 'prisma migrate deploy', cwd } },
    reset: { options: { command: 'prisma migrate reset', cwd } },
    pull: { options: { command: 'prisma db pull', cwd } },
  });
  // The diff script of this package, from the project root.
  assert.match(
    targets['migrate:check']?.options.command ?? '',
    /^node "(\.\.\/)+.*\/prisma\/migrate-diff\.[jt]s" check$/,
  );
  assert.match(
    targets['migrate:create']?.options.command ?? '',
    /^node "(\.\.\/)+.*\/prisma\/migrate-diff\.[jt]s" create$/,
  );
  assert.equal(targets['typecheck'], undefined);
  assert.equal(targets['build'], undefined);
});

test('a project with a schema but no prisma.config.ts gets no Prisma targets', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/db/project.json': projectJson('db'),
    'packages/db/prisma.config.ts': prismaConfig,
    'packages/db/schema.prisma': schema('src/prisma'),
    'packages/other/project.json': projectJson('other'),
    'packages/other/schema.prisma': schema('src/prisma'),
  });

  const listed = await probe.nx('show', 'projects', '--withTarget', 'generate');

  assert.equal(listed.code, 0, listed.output);
  assert.equal(listed.stdout.trim(), 'db');
});

test('each output is relative to the file of its generator block, and a block with no output turns the cache off', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/nested/project.json': projectJson('nested'),
    'packages/nested/prisma.config.ts': prismaConfig,
    'packages/nested/prisma/schema.prisma': `${schema('../generated/client')}\ngenerator erd {\n  provider = "prisma-erd-generator"\n  output   = "./erd.svg"\n}\n`,
    'packages/default/project.json': projectJson('default'),
    'packages/default/prisma.config.ts': prismaConfig,
    'packages/default/schema.prisma': schema(),
  });

  const [nested, fallback] = await Promise.all(
    ['nested', 'default'].map(probe.targets),
  );

  assert.deepEqual(nested?.['generate']?.outputs, [
    '{projectRoot}/generated/client',
    '{projectRoot}/prisma/erd.svg',
  ]);
  assert.equal(nested?.['generate']?.cache, true);
  assert.equal(fallback?.['generate']?.cache, false);
  assert.equal(fallback?.['generate']?.outputs, undefined);
});

test('generate replays from the cache, restores its output, and runs again when a model file changes', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/db/project.json': projectJson('db'),
    'packages/db/prisma.config.ts': prismaConfig,
    'packages/db/schema.prisma': schema('src/prisma'),
    'packages/db/models/user.prisma': model,
  });

  const first = await probe.nx('run', 'db:generate');
  await rm(join(folder.path, 'packages/db/src/prisma'), { recursive: true });
  const replayed = await probe.nx('run', 'db:generate');
  const restored = await probe.read('packages/db/src/prisma/client.ts');
  await probe.write(
    'packages/db/models/post.prisma',
    'model Post {\n  id Int @id\n}\n',
  );
  const changed = await probe.nx('run', 'db:generate');

  assert.equal(first.code, 0, first.output);
  assert.equal(replayed.code, 0, replayed.output);
  assert.match(replayed.output, /Cache: +1\/1 hit/);
  assert.equal(restored, 'client\n');
  assert.equal(changed.code, 0, changed.output);
  assert.equal(
    await probe.read('prisma.log'),
    'prisma generate\nprisma generate\n',
  );
});

test('migrate runs generate first, in the project root', async () => {
  await using folder = await new TemporaryFiles().directory('zukhruf-nx-');
  const probe = await workspace(folder.path, {
    'packages/db/project.json': projectJson('db'),
    'packages/db/prisma.config.ts': prismaConfig,
    'packages/db/schema.prisma': schema('src/prisma'),
  });

  const run = await probe.nx('run', 'db:migrate', '--', '--name', 'init');

  assert.equal(run.code, 0, run.output);
  assert.equal(
    await probe.read('prisma.log'),
    'prisma generate\nprisma migrate dev --name init\n',
  );
  assert.equal(
    await probe.read('packages/db/src/prisma/client.ts'),
    'client\n',
  );
});
