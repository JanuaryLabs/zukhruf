import type { SnapshotState } from '@zukhruf/snapshot-differential';

import type { Position, PositionUpdate, TablePosition } from './position.ts';

// The two phases of a position in memory: no pass saved it yet, or a pass
// saved the tables it saw. Only a saved position has tables.
type Phase =
  | { readonly saved: false }
  | { readonly saved: true; readonly tables: Map<string, TablePosition> };

/** A position in memory: it lasts as long as its feed. */
export class PositionInMemory implements Position {
  #phase: Phase = { saved: false };

  started(): boolean {
    return this.#phase.saved;
  }

  keyColumns(): ReadonlyMap<string, readonly string[]> {
    if (!this.#phase.saved) return new Map();
    return new Map(
      [...this.#phase.tables].map(([table, { keyColumns }]) => [
        table,
        keyColumns,
      ]),
    );
  }

  state(table: string): SnapshotState {
    const position = this.#phase.saved
      ? this.#phase.tables.get(table)
      : undefined;
    if (position === undefined)
      throw new RangeError(`The position has no table ${table}`);
    return position.state;
  }

  save({ tables, dropped }: PositionUpdate): void {
    const kept = this.#phase.saved ? this.#phase.tables : new Map();
    for (const table of dropped) kept.delete(table);
    for (const [table, position] of tables) kept.set(table, position);
    this.#phase = { saved: true, tables: kept };
  }

  [Symbol.dispose](): void {}
}
