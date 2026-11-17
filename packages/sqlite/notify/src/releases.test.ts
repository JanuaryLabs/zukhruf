import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import { Notifications } from './index.ts';
import { addressesOf, hear, startProgram } from './testing/program.ts';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// The next release of this package, as the release would publish it: this
// package's source and package.json, with a raised version and one more
// nullable column in zukhruf_notify_queue. Its own node_modules link resolves
// the dependencies that this package resolves.
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
  const anchor = '    payload TEXT NOT NULL,\n';
  assert.equal(schema.split(anchor).length, 2, 'the anchor is in schema.ts');
  await writeFile(
    schemaPath,
    schema.replace(anchor, `${anchor}    newer_note TEXT,\n`),
  );
  await symlink(
    join(packageRoot, '..', '..', '..', 'node_modules'),
    join(directory, 'node_modules'),
  );
  // In a process of its own, the newer release listens, sends one
  // notification, writes its own column on that row and disposes. The row
  // stays: only the trim of a later notify removes it.
  return async (path: string) => {
    const source = `
      import { open } from '@zukhruf/sqlite-open';
      import { Notifications } from ${JSON.stringify(new URL(`file://${join(directory, 'src', 'index.ts')}`).href)};
      const database = open(${JSON.stringify(path)});
      const notifications = new Notifications({ database, clock: globalThis });
      notifications.on('error', (error) => {
        console.error(error);
        process.exitCode = 1;
      });
      await notifications.listen('jobs');
      notifications.notify('jobs', 'from newer');
      database.exec("UPDATE zukhruf_notify_queue SET newer_note = 'kept' WHERE payload = 'from newer'");
      await notifications[Symbol.asyncDispose]();
      database.close();
    `;
    await run(
      process.execPath,
      ['--no-warnings', '--input-type=module', '--eval', source],
      { cwd: directory, timeout: 30_000 },
    );
  };
}

// The values of the newer release's column, or undefined when the column is
// gone.
function newerNotes(path: string) {
  using reader = open(path, { readOnly: true });
  const columns = reader
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('zukhruf_notify_queue')
    .map(({ name }) => String(name));
  if (!columns.includes('newer_note')) return undefined;
  return reader
    .prepare('SELECT newer_note FROM zukhruf_notify_queue')
    .all()
    .map(({ newer_note }) => newer_note);
}

function recordedRelease(path: string) {
  using reader = open(path, { readOnly: true });
  return reader.prepare('SELECT version FROM zukhruf_notify_version').get()
    ?.version;
}

async function thisRelease() {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  return String(manifest.version);
}

describe('two releases on one file', () => {
  test('an older release constructs on a file a newer release made, keeps its column and its values, and still listens and notifies', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    const newer = await newerRelease(join(folder.path, 'newer'));
    await newer(path);

    await using notifications = new Notifications({
      path,
      clock: createClock(),
    });

    assert.deepEqual(newerNotes(path), ['kept']);
    assert.notEqual(recordedRelease(path), await thisRelease());
    const heard = hear(notifications);
    await notifications.listen('jobs');
    notifications.notify('jobs', 'from older');
    assert.deepEqual(
      (await heard.count(1, { signal: t.signal })).map(
        ({ payload }) => payload,
      ),
      ['from older'],
    );
    assert.deepEqual(heard.errors, []);
  });

  test('records this release on a file that fits and records an earlier release', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    {
      await using first = new Notifications({ path, clock: createClock() });
    }
    {
      // An earlier release with the tables of this one records its own
      // version. No public operation records an earlier version, so it is
      // written in SQL.
      using database = open(path);
      database.exec(`UPDATE zukhruf_notify_version SET version = '0.0.0'`);
    }

    {
      await using notifications = new Notifications({
        path,
        clock: createClock(),
      });
    }

    assert.equal(recordedRelease(path), await thisRelease());
  });

  test('makes again a table or index that a file of this release stores in another shape', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    {
      await using first = new Notifications({ path, clock: createClock() });
    }
    {
      // A file of this release whose index differs, as the source between two
      // releases can make it. No public operation makes another shape, so it
      // is written in SQL.
      using database = open(path);
      database.exec(`DROP INDEX zukhruf_notify_listener_position;
        CREATE INDEX zukhruf_notify_listener_position ON zukhruf_notify_listener (position, id)`);
    }

    {
      await using notifications = new Notifications({
        path,
        clock: createClock(),
      });
    }

    using reader = open(path, { readOnly: true });
    assert.deepEqual(
      reader
        .prepare('SELECT name FROM pragma_index_info(?)')
        .all('zukhruf_notify_listener_position')
        .map(({ name }) => name),
      ['position'],
    );
  });
});

describe('a file that a release before the version record made', () => {
  test('keeps the rows of a listener, which still hears, and records this release', async (t) => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    await using listener = await startProgram(path, { signal: t.signal });
    listener.do({ do: 'listen', channel: 'jobs' });
    await listener.printedOne((p) => p.event === 'listened');
    {
      // The releases before the version record had no zukhruf_notify_version.
      // No public operation makes an older shape, so it is dropped in SQL.
      using database = open(path);
      database.exec('DROP TABLE zukhruf_notify_version');
    }

    await using notifications = new Notifications({
      path,
      clock: createClock(),
    });
    notifications.notify('jobs', 'after');

    assert.deepEqual(
      (await listener.heard(1)).map(({ payload }) => payload),
      ['after'],
    );
    assert.equal(addressesOf(path, listener.pid).length, 1);
    assert.equal(recordedRelease(path), await thisRelease());
  });
});

describe('a construction next to the write of another program', () => {
  test('constructs on a file that this release made while another connection holds the write lock', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    {
      await using first = new Notifications({ path, clock: createClock() });
    }
    using writer = open(path);
    writer.exec('BEGIN IMMEDIATE');
    using database = open(path, { timeout: 0 });

    {
      await using notifications = new Notifications({
        database,
        clock: createClock(),
      });
    }

    assert.equal(recordedRelease(path), await thisRelease());
  });

  test('constructs on a file that a newer release made while another connection holds the write lock, and keeps its column', async () => {
    await using folder = await new TemporaryFiles().directory('notify-');
    const path = join(folder.path, 'app.sqlite');
    const newer = await newerRelease(join(folder.path, 'newer'));
    await newer(path);
    using writer = open(path);
    writer.exec('BEGIN IMMEDIATE');
    using database = open(path, { timeout: 0 });

    {
      await using notifications = new Notifications({
        database,
        clock: createClock(),
      });
    }

    writer.exec('ROLLBACK');
    assert.deepEqual(newerNotes(path), ['kept']);
  });
});
