# Recipe: Build a database file, then move it into place

**Use case.** An owner makes a new version of a database in full, for example a copy of data that it pulls from a service. Readers must see the whole new version or the old one, never a part. The owner builds the new file beside the live file, and then moves it into place with `rename`. `rename` moves one file. In a write-ahead log, the commits can be in the `-wal` file, and SQLite keeps its index in the `-shm` file. These two files do not move with the database file. When the owner stops before it closes the connection, the moved file does not have the commits. `RollbackJournal` writes each commit into the database file, so the file is complete when `rename` moves it ([ADR 0004](../adr/0004-the-journal-is-a-strategy.md)).

**What you need.** `open` and `RollbackJournal` of this package, and `rename` of `node:fs/promises`.

## The steps

1. Open a staging file in the folder of the live file, with `open(staging, { journal: new RollbackJournal() })`.
2. Build the new version in the staging file, and close the connection.
3. Move the staging file into place with `rename(staging, live)`.

## The program

A child process builds the staging file, commits, and stops before it closes the connection, as a program that crashes does. Then the program moves the staging file into place, and counts the tables of the live file. It does this once with `WriteAheadLog` and once with `RollbackJournal`.

```ts title="build-then-move.ts"
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtempDisposable, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RollbackJournal, WriteAheadLog, open } from '@zukhruf/sqlite-open';

const [role, staging, journalName] = process.argv.slice(2);

if (role === 'build') {
  // The owner builds the new file, commits, and stops before it closes the
  // connection, as a program that crashes does.
  const journal =
    journalName === 'RollbackJournal'
      ? new RollbackJournal()
      : new WriteAheadLog();
  const database = open(staging!, { journal });
  database.exec(`CREATE TABLE notes (title TEXT);
    INSERT INTO notes VALUES ('first'), ('second')`);
  process.exit(0);
} else {
  for (const journal of ['WriteAheadLog', 'RollbackJournal']) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'build-'));
    const live = join(scratch.path, 'notes.sqlite');
    const staging = `${live}.tmp`;

    // Build the file beside the live one, then move it into place.
    execFileSync(process.execPath, [
      ...process.execArgv,
      import.meta.filename,
      'build',
      staging,
      journal,
    ]);
    console.log(
      `${journal}, after the build: ${readdirSync(scratch.path).toSorted().join(', ')}`,
    );
    await rename(staging, live);
    console.log(
      `${journal}, after the rename: ${readdirSync(scratch.path).toSorted().join(', ')}`,
    );

    using reader = open(live, { readOnly: true });
    const tables = reader
      .prepare(
        "SELECT count(*) AS tables FROM sqlite_schema WHERE name = 'notes'",
      )
      .get();
    console.log(
      `${journal}, tables named notes in the live file: ${tables?.tables}`,
    );
  }
}
```

Output:

```
WriteAheadLog, after the build: notes.sqlite.tmp, notes.sqlite.tmp-shm, notes.sqlite.tmp-wal
WriteAheadLog, after the rename: notes.sqlite, notes.sqlite.tmp-shm, notes.sqlite.tmp-wal
WriteAheadLog, tables named notes in the live file: 0
RollbackJournal, after the build: notes.sqlite.tmp
RollbackJournal, after the rename: notes.sqlite
RollbackJournal, tables named notes in the live file: 1
```

## What the output shows

- With `WriteAheadLog`, the commit was in the `-wal` file. `rename` moved only the database file, so the live file has no `notes` table, and the `-wal` and `-shm` files stay behind with the old name.
- With `RollbackJournal`, the commit was in the database file. The folder had no other file, and the live file has the `notes` table.

## Things to know

- **Keep the staging file in the folder of the live file.** `rename` moves a file only in one file system. Across two file systems it fails with `EXDEV` (rename(2)).
- **A failed build keeps the old version.** The live file changes only at `rename`.
- **Close the connection before `rename`.** The program above stops before the close only to show what a crash leaves.
- **An owner can change the live file to a write-ahead log later.** `open(live)` with the default journal changes a file in a rollback journal to a write-ahead log ([src/open.test.ts](../../src/open.test.ts)). See [Journals](../../README.md#journals).
