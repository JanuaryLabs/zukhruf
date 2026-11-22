import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { TestClock } from 'pg-boss';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import { SqliteJobQueue } from './index.ts';
import { id } from './testing/job-id.ts';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// The next release of this package, as the release would publish it: this
// package's source and package.json, with a raised version and one more
// nullable column in pgboss_job. Its own node_modules link resolves the
// dependencies that this package resolves.
async function newerRelease(directory: string) {
  await cp(join(packageRoot, 'src'), join(directory, 'src'), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  // The release after this one raises the patch, as fixed versioning does
  // for a fix.
  const version = String(manifest.version).replace(/\d+$/, (patch) =>
    String(Number(patch) + 1),
  );
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ ...manifest, version }),
  );
  const schemaPath = join(directory, 'src', 'schema.ts');
  const schema = await readFile(schemaPath, 'utf8');
  const anchor = '    source_root_id TEXT,\n';
  assert.equal(schema.split(anchor).length, 2, 'the anchor is in schema.ts');
  await writeFile(
    schemaPath,
    schema.replace(anchor, `${anchor}    newer_note TEXT,\n`),
  );
  await symlink(
    join(packageRoot, '..', '..', '..', 'node_modules'),
    join(directory, 'node_modules'),
  );
  // Starts the newer release on the file in a process of its own, sends a
  // job when asked to, and prints the ids of the jobs it finds. An error
  // event fails the process, and so the call.
  return async (path: string, send?: string) => {
    const source = `
      import { SqliteJobQueue } from ${JSON.stringify(new URL(`file://${join(directory, 'src', 'index.ts')}`).href)};
      const queue = new SqliteJobQueue({ path: ${JSON.stringify(path)}, schedule: false, supervise: false });
      queue.on('error', (error) => {
        console.error(error);
        process.exitCode = 1;
      });
      await queue.start();
      await queue.createQueue('jobs');
      ${send === undefined ? '' : `await queue.send('jobs', { from: 'newer' }, { id: ${JSON.stringify(send)} });`}
      console.log(JSON.stringify((await queue.findJobs('jobs')).map((job) => job.id).sort()));
      await queue.stop({ graceful: false, close: true });
    `;
    const { stdout } = await run(
      process.execPath,
      ['--no-warnings', '--input-type=module', '--eval', source],
      { timeout: 30_000 },
    );
    const ids: unknown = JSON.parse(stdout);
    return ids;
  };
}

// The text of each object that sqlite_schema keeps.
function storedSchema(database: DatabaseSync) {
  return database
    .prepare('SELECT name, sql FROM sqlite_schema ORDER BY name')
    .all()
    .map(({ name, sql }) => ({ name: String(name), sql }));
}

function jobColumns(path: string) {
  using database = open(path);
  return database
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('pgboss_job')
    .map(({ name }) => String(name));
}

describe('two releases on one queue file', () => {
  it('an older release starts on a file a newer release made, keeps its column, and works its jobs', async () => {
    await using scratch = await new TemporaryFiles().directory('queue-');
    const path = join(scratch.path, 'queue.sqlite');
    const newer = await newerRelease(join(scratch.path, 'newer'));
    await newer(path, id(1));
    // The newer release sent its job on the real clock, so the test clock
    // starts after it.
    const clock = new TestClock(new Date().toISOString());
    const queue = new SqliteJobQueue({ path, clock, schedule: false });
    const errors: string[] = [];
    queue.on('error', (error) => errors.push(error.message));
    try {
      await queue.start();
      await queue.send('jobs', { from: 'older' }, { id: id(2) });
      const ran: string[] = [];
      await queue.work('jobs', { batchSize: 2 }, async (jobs) => {
        ran.push(...jobs.map((job) => job.id));
      });
      await clock.tick(2000);

      assert.deepEqual(ran.sort(), [id(1), id(2)]);
      assert.deepEqual(errors, []);
    } finally {
      await queue.stop({ graceful: false, close: true });
    }
    assert.ok(jobColumns(path).includes('newer_note'));
  });

  it('a newer release starts on a file an older release made, adds its column, and keeps the jobs', async () => {
    await using scratch = await new TemporaryFiles().directory('queue-');
    const path = join(scratch.path, 'queue.sqlite');
    const newer = await newerRelease(join(scratch.path, 'newer'));
    const queue = new SqliteJobQueue({ path, schedule: false });
    try {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', { from: 'older' }, { id: id(1) });
    } finally {
      await queue.stop({ graceful: false, close: true });
    }

    const found = await newer(path);

    assert.deepEqual(found, [id(1)]);
    assert.ok(jobColumns(path).includes('newer_note'));
  });

  it('a newer release whose CREATE statements differ from the file only in their pg-boss citations starts on it, rebuilds no table, and keeps the jobs', async () => {
    await using scratch = await new TemporaryFiles().directory('queue-');
    const path = join(scratch.path, 'queue.sqlite');
    const older = new SqliteJobQueue({
      path,
      schedule: false,
      supervise: false,
    });
    try {
      await older.start();
      await older.createQueue('jobs');
      await older.send('jobs', { from: 'older' }, { id: id(1) });
    } finally {
      await older.stop({ graceful: false, close: true });
    }
    const before = (() => {
      // An earlier release cited other lines of pg-boss in the comments of
      // its CREATE statements, as 12.38.2 did before the port to 12.39.0, and
      // recorded its own version. No public operation makes that text, so it
      // is written in SQL, with SQLite's defensive mode off so that
      // writable_schema can change sqlite_schema.
      using database = open(path, { defensive: false });
      database.exec(`UPDATE pgboss_version SET version = '0.0.0'`);
      database.exec('PRAGMA writable_schema = ON');
      const update = database.prepare(
        'UPDATE sqlite_schema SET sql = ? WHERE name = ?',
      );
      for (const { name, sql } of database
        .prepare('SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL')
        .all())
        update.run(
          String(sql).replaceAll(
            /(\.js:(?:\s*--\s*)?)\d+(?:-\d+)?/g,
            (_, cite: string) => `${cite}1`,
          ),
          String(name),
        );
      database.exec('PRAGMA writable_schema = OFF');
      return storedSchema(database);
    })();
    assert.match(
      String(before.find(({ name }) => name === 'pgboss_job')?.sql),
      /plans\.js:\s*--\s*1\)/,
    );

    const queue = new SqliteJobQueue({
      path,
      schedule: false,
      supervise: false,
    });
    try {
      await queue.start();
      assert.deepEqual(
        (await queue.findJobs('jobs')).map((job) => job.id),
        [id(1)],
      );
    } finally {
      await queue.stop({ graceful: false, close: true });
    }

    using database = open(path);
    assert.deepEqual(storedSchema(database), before);
  });

  it('records this release on a file that fits and records an earlier release', async () => {
    await using scratch = await new TemporaryFiles().directory('queue-');
    const path = join(scratch.path, 'queue.sqlite');
    const first = new SqliteJobQueue({
      path,
      schedule: false,
      supervise: false,
    });
    try {
      await first.start();
    } finally {
      await first.stop({ graceful: false, close: true });
    }
    {
      // An earlier release with the schema of this one records its own
      // version. No public operation records an earlier version, so it is
      // written in SQL.
      using database = open(path);
      database.exec(`UPDATE pgboss_version SET version = '0.0.0'`);
    }
    const queue = new SqliteJobQueue({
      path,
      schedule: false,
      supervise: false,
    });
    try {
      await queue.start();
    } finally {
      await queue.stop({ graceful: false, close: true });
    }

    // Only pgboss_version shows the release: the file fits both releases.
    using database = open(path);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    );
    assert.equal(
      database.prepare('SELECT version FROM pgboss_version').get()?.version,
      manifest.version,
    );
  });
});

describe('a start next to the write of another program', () => {
  it('starts on a file that this release made while another connection holds the write lock', async () => {
    await using scratch = await new TemporaryFiles().directory('queue-');
    const path = join(scratch.path, 'queue.sqlite');
    const first = new SqliteJobQueue({
      path,
      schedule: false,
      supervise: false,
    });
    try {
      await first.start();
    } finally {
      await first.stop({ graceful: false, close: true });
    }
    using writer = open(path);
    writer.exec('BEGIN IMMEDIATE');
    using database = open(path, { timeout: 0 });
    const queue = new SqliteJobQueue({
      database,
      schedule: false,
      supervise: false,
    });
    try {
      await queue.start();
    } finally {
      await queue.stop({ graceful: false });
    }
  });

  it('starts on a file that a newer release made while another connection holds the write lock, and keeps its column', async () => {
    await using scratch = await new TemporaryFiles().directory('queue-');
    const path = join(scratch.path, 'queue.sqlite');
    const newer = await newerRelease(join(scratch.path, 'newer'));
    await newer(path);
    using writer = open(path);
    writer.exec('BEGIN IMMEDIATE');
    using database = open(path, { timeout: 0 });
    const queue = new SqliteJobQueue({
      database,
      schedule: false,
      supervise: false,
    });
    try {
      await queue.start();
    } finally {
      await queue.stop({ graceful: false });
    }
    writer.exec('ROLLBACK');
    assert.ok(jobColumns(path).includes('newer_note'));
  });
});
