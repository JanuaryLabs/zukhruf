import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@zukhruf/sqlite-transaction';

import { Release } from './release.ts';
import { queueSchema } from './schema.ts';

// pg-boss's contractor.start() (node_modules/pg-boss/dist/contractor.js:
// 83-95): a file that a newer release made stays as it is, and any other file
// gets this release's schema with its rows kept (docs/adr/0004, 0006).
export class Contractor {
  static start(database: DatabaseSync): void {
    // pg-boss reads isInstalled() and schemaVersion() with no lock
    // (contractor.js:83-95), and locks only in create() and migrate()
    // (plans.js:143, :166). A WAL reader does not wait for a writer, so a
    // file that needs no change starts next to the write of another program.
    if (Contractor.#settled(database)) return;
    // The rebuild of pgboss_queue needs foreign keys off, which SQLite cannot
    // change inside a transaction, and the read of the release must share the
    // write lock with the apply. In a transaction of the caller, the keys stay
    // as they are, and the declaration fails before it changes the file.
    const keys =
      !database.isTransaction &&
      Number(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys) === 1;
    if (keys) database.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(
        database,
        () => {
          const installed = Contractor.#installed(database);
          if (installed?.isAfter(Release.current)) return;
          queueSchema.apply(database);
          database
            .prepare(
              `INSERT INTO pgboss_version (singleton, version) VALUES (1, ?)
              ON CONFLICT (singleton) DO UPDATE SET version = excluded.version`,
            )
            .run(Release.current.version);
        },
        { mode: 'immediate' },
      );
    } finally {
      if (keys) database.exec('PRAGMA foreign_keys = ON');
    }
  }

  // The file records a later release, or this release and fits the
  // declaration. The two reads share one snapshot. The locked transaction
  // reads both again, so a program that changes the file after this read
  // cannot make start() act on it.
  static #settled(database: DatabaseSync): boolean {
    return transaction(
      database,
      () => {
        const installed = Contractor.#installed(database);
        if (installed === undefined) return false;
        if (installed.isAfter(Release.current)) return true;
        return (
          installed.version === Release.current.version &&
          queueSchema.drift(database) === 'fits'
        );
      },
      { mode: 'deferred' },
    );
  }

  // The release that the file records. A file that a release before the
  // version column made records none. Under the write lock, the table cannot
  // change before the apply.
  static #installed(database: DatabaseSync): Release | undefined {
    const recorded = database
      .prepare(
        `SELECT 1 FROM pragma_table_info('pgboss_version') WHERE name = 'version'`,
      )
      .get();
    if (recorded === undefined) return undefined;
    const row = database.prepare('SELECT version FROM pgboss_version').get();
    return typeof row?.version === 'string'
      ? new Release(row.version)
      : undefined;
  }
}
