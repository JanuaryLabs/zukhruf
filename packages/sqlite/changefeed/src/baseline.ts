import type { Start } from './start.ts';
import { type TableChanges, snapshotOf } from './table-changes.ts';
import type { Table } from './tables.ts';

/**
 * The first pass is a baseline: it keeps the fingerprint of each row, and
 * gives no events. Later passes give only the changes after it.
 */
export class Baseline implements Start {
  async table(table: Table): Promise<TableChanges> {
    return { events: [], state: await snapshotOf(table) };
  }
}
