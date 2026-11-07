import type { Start } from './start.ts';
import { type TableChanges, tableChanges } from './table-changes.ts';
import type { Table } from './tables.ts';

/** The first pass gives a read for each row of each table. */
export class ReadEveryRow implements Start {
  table(table: Table): Promise<TableChanges> {
    return tableChanges(table, null);
  }
}
