# Recipe: Check the columns of each read on a shared snapshot

**Use case.** A reader opens one snapshot and runs several reads on it. Each read uses its own tables. The owner changes its layout, and one table loses a column. Only the reads of that table must fail. `requireColumns` closes the snapshot when a column is missing, so each read after it fails with `database is not open` ([src/snapshot.test.ts](../../src/snapshot.test.ts), "a layout without the required columns fails with MissingColumnsError, naming each one, and closes"). Two readers in the elt repository, Knowledge and Accounts, check each read with `missingColumns` for this reason (`.agents/skills/add-elt-source/SKILL.md`, line 118, in elt).

**What you need.** `Snapshot`, `SnapshotColumns` and `MissingColumnsError`.

## The steps

1. Open one snapshot for all the reads.
2. Give each read its required columns, as `{ table: [column, ...] }`.
3. Before each read, call `missingColumns` with the required columns of that read.
4. When the list is not empty, throw `MissingColumnsError` with `snapshot.path` and the list. The snapshot stays open for the other reads.

## The program

The owner has the tables `accounts` and `credentials`, and `credentials` has no column `service`. The program runs two reads on one snapshot two times: first with `requireColumns` before each read, then with `missingColumns`.

```ts title="shared-snapshot.ts"
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MissingColumnsError,
  Snapshot,
  type SnapshotColumns,
} from '@zukhruf/sqlite-snapshot';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'accounts-'));
const path = join(scratch.path, 'accounts.sqlite');

// The owner: a new version removed the column credentials.service.
using owner = new DatabaseSync(path);
owner.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE credentials (id INTEGER PRIMARY KEY, account TEXT);
  INSERT INTO accounts (name) VALUES ('work'), ('home');
  INSERT INTO credentials (account) VALUES ('work')`);

// Two reads on one snapshot. Each read uses its own table.
const reads: { name: string; columns: SnapshotColumns; sql: string }[] = [
  {
    name: 'credentials',
    columns: { credentials: ['id', 'account', 'service'] },
    sql: 'SELECT id, account, service FROM credentials',
  },
  {
    name: 'accounts',
    columns: { accounts: ['id', 'name'] },
    sql: 'SELECT id, name FROM accounts',
  },
];

function run(check: (snapshot: Snapshot, columns: SnapshotColumns) => void) {
  using snapshot = new Snapshot(path);
  for (const read of reads) {
    try {
      check(snapshot, read.columns);
      console.log(`  ${read.name}: ${snapshot.all(read.sql).length} rows`);
    } catch (error) {
      if (error instanceof MissingColumnsError)
        console.log(`  ${read.name}: MissingColumnsError, ${error.missing}`);
      else if (error instanceof Error)
        console.log(`  ${read.name}: ${error.message}`);
      else throw error;
    }
  }
}

console.log('requireColumns for each read:');
run((snapshot, columns) => snapshot.requireColumns(columns));

console.log('missingColumns for each read:');
run((snapshot, columns) => {
  const missing = snapshot.missingColumns(columns);
  if (missing.length > 0) throw new MissingColumnsError(snapshot.path, missing);
});
```

Output:

```
requireColumns for each read:
  credentials: MissingColumnsError, credentials.service
  accounts: database is not open
missingColumns for each read:
  credentials: MissingColumnsError, credentials.service
  accounts: 2 rows
```

## Why it works

- `requireColumns` calls `missingColumns`. When the list is not empty, it disposes the snapshot, then throws `MissingColumnsError` ([src/snapshot.ts](../../src/snapshot.ts)). The read of `accounts` then finds a closed connection, and `node:sqlite` throws `database is not open`. The table `accounts` has all its columns, but the read fails.
- `missingColumns` only reads `pragma_table_info` for each table, and gives the missing columns as `table.column`. It does not close the snapshot. Thus the read of `credentials` fails, and the read of `accounts` gives its 2 rows.
- The caller throws `MissingColumnsError` of the package, not an error of its own. A catch with `instanceof MissingColumnsError` thus works for both methods. Knowledge and Accounts in elt do the same (`packages/sdks/apple/knowledge/src/knowledge-store.ts`, line 74, and `packages/sdks/apple/accounts/src/accounts-snapshot.ts`, line 413, in elt).

## Things to know

- **When all reads of a snapshot use the same tables, use `requireColumns` one time.** Call it when the snapshot opens, with each column of each read. Then no read starts on a layout that it cannot read. See [The rules](../../README.md#the-rules).
- **The package throws its own errors.** A host that needs its own error translates `MissingColumnsError` at its boundary, and keeps it as `cause` ([ADR 0002](../adr/0002-the-package-throws-its-own-errors.md)).
