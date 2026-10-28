import type { SnapshotState } from '@zukhruf/snapshot-differential';

import type { Position, PositionUpdate, TablePosition } from './position.ts';

// The position of an observing feed: in memory, for one run.
export class PositionInMemory implements Position {
  readonly #tables = new Map<string, TablePosition>();

  keyColumns(): ReadonlyMap<string, readonly string[]> {
    return new Map(
      [...this.#tables].map(([table, { keyColumns }]) => [table, keyColumns]),
    );
  }

  state(table: string): SnapshotState {
    const position = this.#tables.get(table);
    if (position === undefined)
      throw new RangeError(`The position has no table ${table}`);
    return position.state;
  }

  save({ tables, dropped }: PositionUpdate): void {
    for (const table of dropped) this.#tables.delete(table);
    for (const [table, position] of tables) this.#tables.set(table, position);
  }
}
