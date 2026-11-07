import type { TableChanges } from './table-changes.ts';
import type { Table } from './tables.ts';

/**
 * What the first pass of a position that no pass saved gives for each table.
 * After that save, a pass gives a read for each row of a new table. A new
 * start is a class that implements this interface.
 */
export interface Start {
  /** The change events and the snapshot of one table at the first pass. */
  table(table: Table): Promise<TableChanges>;
}
