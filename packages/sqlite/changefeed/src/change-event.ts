import type { SQLOutputValue } from 'node:sqlite';

import type { KeyValue } from '@zukhruf/snapshot-differential';

// The values of the key columns of a row, by column.
export type Key = Readonly<Record<string, KeyValue>>;

// A row as SQLite gives it, in a plain object.
export type Row = Readonly<Record<string, SQLOutputValue>>;

// What a pass gives for one row, or for a table that the owner dropped or
// gave other key columns.
export type ChangeEvent =
  | {
      readonly table: string;
      readonly op: 'read' | 'insert' | 'update';
      readonly key: Key;
      readonly after: Row;
    }
  | { readonly table: string; readonly op: 'delete'; readonly key: Key }
  | { readonly table: string; readonly op: 'truncate' };
