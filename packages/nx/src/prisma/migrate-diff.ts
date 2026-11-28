// The migration targets of `@zukhruf/nx/prisma` run this in the project root:
// `node migrate-diff.js check` for `migrate:check`, and
// `node migrate-diff.js create --name <name>` for `migrate:create`. Each runs
// `prisma migrate diff` from the migrations folder to the schema folder.
// Prisma replays the migrations on a shadow database, which it reads from
// `datasource.shadowDatabaseUrl` of prisma.config.ts. The shadow database
// follows the `provider` of the schema's datasource block (ADR 0018):
// - postgresql: Prisma never creates the shadow database, so this script sets
//   SHADOW_CONNECTION_STRING, which the generated config reads, to a new,
//   empty database of @zukhruf/testing/postgres, and drops it after the diff.
// - sqlite: with no shadow URL, Prisma replays the migrations on an in-memory
//   SQLite database, so this script sets nothing and starts no database.
import { glob, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { Command, ExitError } from '@zukhruf/process';

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

interface Shadow extends AsyncDisposable {
  /** The variables that give Prisma the shadow database. */
  readonly environment: Record<string, string>;
}

class PostgresShadow implements Shadow {
  static async create(): Promise<PostgresShadow> {
    // Imported here: @zukhruf/testing is an optional peer, and a repo whose
    // db packages all use SQLite need not install it.
    const { Postgres } = await import('@zukhruf/testing/postgres');
    return new PostgresShadow(
      await new Postgres({ environment: process.env }).database(),
    );
  }

  readonly #database: AsyncDisposable & { connectionString: string };

  private constructor(
    database: AsyncDisposable & { connectionString: string },
  ) {
    this.#database = database;
  }

  get environment() {
    return { SHADOW_CONNECTION_STRING: this.#database.connectionString };
  }

  [Symbol.asyncDispose]() {
    return this.#database[Symbol.asyncDispose]();
  }
}

class SqliteShadow implements Shadow {
  readonly environment = {};

  async [Symbol.asyncDispose]() {}
}

const shadows: Record<string, () => Promise<Shadow>> = {
  postgresql: () => PostgresShadow.create(),
  sqlite: async () => new SqliteShadow(),
};

const datasourceBlock = /^\s*datasource\s+\w+\s*\{([^}]*)\}/m;
const providerLine = /^\s*provider\s*=\s*"([^"]+)"/m;

// The `provider` of the datasource block, from the `*.prisma` files of the
// schema folder, as `--to-schema .` reads them.
async function provider(): Promise<string> {
  for await (const file of glob('**/*.prisma', {
    exclude: ['**/node_modules/**'],
  })) {
    const block = datasourceBlock.exec(await readFile(file, 'utf8'))?.[1];
    const name =
      block === undefined ? undefined : providerLine.exec(block)?.[1];
    if (name !== undefined) {
      return name;
    }
  }
  throw new Error(
    'No *.prisma file of this project has a datasource block with a provider.',
  );
}

const run = parse();
const declared = await provider();
const shadowOf = shadows[declared];
if (shadowOf === undefined) {
  throw new Error(
    `migrate-diff has no shadow database for the datasource provider "${declared}" of this schema. It has one for ${Object.keys(shadows).join(' and ')}.`,
  );
}
await using shadow = await shadowOf();
const prisma = await new Command(
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
  { env: { ...process.env, ...shadow.environment }, clock: globalThis },
).start({ stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
const end = await prisma.ended;
if (end.signal !== undefined) {
  throw new ExitError('prisma migrate diff', end);
}
// With --exit-code, Prisma exits 2 when the diff is not empty.
if (run.command === 'check' && end.exitCode === 2) {
  console.error(
    'The migrations do not build the schema. The diff above goes from the migrations to the schema. Write it as a new migration with the migrate:create target of this project (--name <name>), or change the schema to match the migrations.',
  );
}
if (run.command === 'create' && end.exitCode === 0) {
  console.error(`Wrote ${run.output}.`);
}
process.exitCode = end.exitCode;
