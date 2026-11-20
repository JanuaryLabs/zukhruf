// The migration targets of `@zukhruf/nx/prisma` run this in the project root:
// `node migrate-diff.js check` for `migrate:check`, and
// `node migrate-diff.js create --name <name>` for `migrate:create`. Each runs
// `prisma migrate diff` from the migrations folder to the schema folder.
// Prisma replays the migrations on the shadow database, which it reads from
// `datasource.shadowDatabaseUrl` of prisma.config.ts and never creates (ADR
// 0018). The generated config reads it from SHADOW_CONNECTION_STRING, so this
// script sets that variable to a new, empty database of
// @zukhruf/testing/postgres, and drops the database after the diff.
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { Postgres } from '@zukhruf/testing/postgres';

type Run = { command: 'check' } | { command: 'create'; output: string };

function parse(): Run {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { name: { type: 'string' } },
  });
  const [command] = positionals;
  if (command === 'check' && values.name === undefined) {
    return { command };
  }
  if (command === 'create' && values.name !== undefined) {
    // The folder name of `prisma migrate dev`: the UTC time to the second,
    // then the name.
    const time = new Date().toISOString().replaceAll(/\D/g, '').slice(0, 14);
    return {
      command,
      output: `migrations/${time}_${values.name}/migration.sql`,
    };
  }
  if (command === 'create') {
    throw new Error('Name the new migration: migrate:create --name <name>.');
  }
  throw new Error(
    'Run `migrate-diff.js check`, or `migrate-diff.js create --name <name>`.',
  );
}

const run = parse();
await using shadow = await new Postgres({
  environment: process.env,
}).database();
const prisma = spawn(
  'prisma',
  [
    'migrate',
    'diff',
    '--from-migrations',
    'migrations',
    // The folder, not schema.prisma: with the models in models/*.prisma, a
    // diff to schema.prisma alone removes every table.
    '--to-schema',
    '.',
    ...(run.command === 'check'
      ? ['--exit-code']
      : ['--script', '--output', run.output]),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, SHADOW_CONNECTION_STRING: shadow.connectionString },
  },
);
const {
  promise: exit,
  resolve,
  reject,
} = Promise.withResolvers<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>();
prisma.once('error', reject);
prisma.once('close', (code, signal) => resolve({ code, signal }));
// Node gives the code null when a signal ended the child.
const { code, signal } = await exit;
if (code === null) {
  throw new Error(`prisma migrate diff stopped on ${signal}.`);
}
// With --exit-code, Prisma exits 2 when the diff is not empty.
if (run.command === 'check' && code === 2) {
  console.error(
    'The migrations do not build the schema. The diff above goes from the migrations to the schema. Write it as a new migration with the migrate:create target of this project (--name <name>), or change the schema to match the migrations.',
  );
}
if (run.command === 'create' && code === 0) {
  console.error(`Wrote ${run.output}.`);
}
process.exitCode = code;
