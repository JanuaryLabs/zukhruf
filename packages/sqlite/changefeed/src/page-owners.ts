import { closeSync, openSync, readSync } from 'node:fs';

import type { ChangedPages } from './wal-frames.ts';

/** A b-tree of the database: the table it belongs to and its root page. */
export type BTree = { readonly table: string; readonly rootpage: number };

const interiorTable = 0x05;
const interiorIndex = 0x02;

/**
 * The table of each page of the b-trees, by their interior pages only: each
 * page of one level of a b-tree has the type of that level, so a walk reads
 * one child to know a level of leaves, and lists the leaves unread. For the
 * Mail import of Context Compiler (1,038,283 pages) it reads 1,452 pages in
 * about 100 ms. A page that the WAL holds is read from its newest frame.
 * Overflow and free pages belong to no b-tree, and have no table here.
 */
export function pageOwners(
  databasePath: string,
  btrees: readonly BTree[],
  changed: ChangedPages,
): ReadonlyMap<number, string> {
  const database = openSync(databasePath, 'r');
  const wal = openSync(`${databasePath}-wal`, 'r');
  try {
    const page = Buffer.alloc(changed.pageSize);
    const read = (pgno: number) => {
      const frame = changed.newest.get(pgno);
      if (frame === undefined)
        readSync(
          database,
          page,
          0,
          changed.pageSize,
          (pgno - 1) * changed.pageSize,
        );
      else readSync(wal, page, 0, changed.pageSize, frame);
      // Page 1 starts with the 100-byte header of the database file.
      const header = pgno === 1 ? 100 : 0;
      return { header, type: page[header] };
    };
    const owners = new Map<number, string>();
    for (const { table, rootpage } of btrees) {
      for (let level = [rootpage]; ;) {
        const [first] = level;
        if (first === undefined) break;
        for (const pgno of level) owners.set(pgno, table);
        const { type } = read(first);
        if (type !== interiorTable && type !== interiorIndex) break;
        const next: number[] = [];
        for (const pgno of level) {
          const { header } = read(pgno);
          next.push(page.readUInt32BE(header + 8));
          const cells = page.readUInt16BE(header + 3);
          for (let cell = 0; cell < cells; cell++)
            next.push(
              page.readUInt32BE(page.readUInt16BE(header + 12 + 2 * cell)),
            );
        }
        level = next;
      }
    }
    return owners;
  } finally {
    closeSync(database);
    closeSync(wal);
  }
}
