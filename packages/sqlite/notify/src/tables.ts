import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@zukhruf/sqlite-transaction';

import { Release } from './release.ts';
import { notifySchema } from './schema.ts';

// The tables of a file: a file that a later release made stays as it is, and
// any other file gets this release's tables with their rows kept (docs/adr/
// 0009). A copy of Contractor of @zukhruf/sqlite-queue (docs/copied-from-
// sqlite-queue.md).
export class Tables {
  static install(database: DatabaseSync): void {
    // A WAL reader does not wait for a writer, so a file that needs no change
    // gets its Notifications next to the write of another program.
    if (Tables.#settled(database)) return;
    // The read of the release must share the write lock with the apply.
    transaction(
      database,
      () => {
        const installed = Tables.#installed(database);
        if (installed?.isAfter(Release.current)) return;
        notifySchema.apply(database);
        database
          .prepare(
            `INSERT INTO zukhruf_notify_version (singleton, version) VALUES (1, ?)
            ON CONFLICT (singleton) DO UPDATE SET version = excluded.version`,
          )
          .run(Release.current.version);
      },
      { mode: 'immediate' },
    );
  }

  // The file records a later release, or this release and fits the
  // declaration. The two reads share one snapshot. The locked transaction
  // reads both again, so a program that changes the file after this read
  // cannot make install() act on it.
  static #settled(database: DatabaseSync): boolean {
    return transaction(
      database,
      () => {
        const installed = Tables.#installed(database);
        if (installed === undefined) return false;
        if (installed.isAfter(Release.current)) return true;
        return (
          installed.version === Release.current.version &&
          notifySchema.drift(database) === 'fits'
        );
      },
      { mode: 'deferred' },
    );
  }

  // The release that the file records. A new file, or a file that a release
  // before the version record made, records none.
  static #installed(database: DatabaseSync): Release | undefined {
    const recorded = database
      .prepare(
        `SELECT 1 FROM pragma_table_info('zukhruf_notify_version') WHERE name = 'version'`,
      )
      .get();
    if (recorded === undefined) return undefined;
    const row = database
      .prepare('SELECT version FROM zukhruf_notify_version')
      .get();
    return typeof row?.version === 'string'
      ? new Release(row.version)
      : undefined;
  }
}
