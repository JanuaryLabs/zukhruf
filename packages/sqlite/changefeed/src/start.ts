import type { TableChanges } from './table-changes.ts';
import type { Table } from './tables.ts';

/**
 * What the first pass gives for each table while the feed's partition has no
 * checkpoint. After that pass, a pass gives a read for each row of a new
 * table. A new start is a class that implements this interface.
 */
export interface Start {
  /** The change events and the snapshot of one table at the first pass. */
  table(table: Table): Promise<TableChanges>;
}
