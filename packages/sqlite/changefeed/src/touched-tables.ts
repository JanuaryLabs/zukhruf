import type { Snapshot } from '@zukhruf/sqlite-snapshot';

import { pageOwners } from './page-owners.ts';
import { type ChangedPages, walSalt } from './wal-frames.ts';

/**
 * The tables whose b-tree pages the new frames of the owner's WAL wrote, or
 * null when the pass must read every table: a frame wrote a page of the
 * schema, so a table can be new, dropped or of another shape, or the WAL was
 * reset while the pages were read, so they can be of the new WAL.
 */
export function touchedTables(
  databasePath: string,
  snapshot: Snapshot,
  changed: ChangedPages,
  salt: string,
): ReadonlySet<string> | null {
  const owners = pageOwners(
    databasePath,
    [
      { table: 'sqlite_schema', rootpage: 1 },
      ...snapshot
        .all('SELECT tbl_name, rootpage FROM sqlite_schema WHERE rootpage > 0')
        .map(({ tbl_name, rootpage }) => ({
          table: String(tbl_name),
          rootpage: Number(rootpage),
        })),
    ],
    changed,
  );
  if (walSalt(databasePath) !== salt) return null;
  const tables = new Set<string>();
  for (const page of changed.pages) {
    const owner = owners.get(page);
    if (owner === 'sqlite_schema') return null;
    if (owner !== undefined) tables.add(owner);
  }
  return tables;
}
