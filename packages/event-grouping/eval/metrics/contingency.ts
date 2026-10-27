// A partition gives each mention its entity: the report id and its event.
// The key (the answer key) and the response (the detector) can hold other
// mentions, as in the reference scorer.
export type Partition = ReadonlyMap<string, string>;

// The overlap of the key and the response, from which each metric is
// computed. A cell is one key entity and one response entity that share
// mentions.
export class Contingency {
  // The size of each key entity, and of each response entity.
  readonly keySizes: readonly number[];
  readonly responseSizes: readonly number[];
  readonly cells: readonly {
    readonly key: number;
    readonly response: number;
    readonly count: number;
  }[];

  constructor(key: Partition, response: Partition) {
    const keyIndex = indexOf(key);
    const responseIndex = indexOf(response);
    this.keySizes = sizes(key, keyIndex);
    this.responseSizes = sizes(response, responseIndex);
    const counts = new Map<
      string,
      { key: number; response: number; count: number }
    >();
    for (const [mention, entity] of key) {
      const other = response.get(mention);
      if (other === undefined) continue;
      const keyEntity = keyIndex.get(entity)!;
      const responseEntity = responseIndex.get(other)!;
      const id = `${keyEntity} ${responseEntity}`;
      const cell = counts.get(id);
      if (cell === undefined)
        counts.set(id, { key: keyEntity, response: responseEntity, count: 1 });
      else cell.count++;
    }
    this.cells = [...counts.values()];
  }

  // The number of mentions of each key entity that the response also has,
  // and of each response entity that the key also has.
  get keyShared(): number[] {
    return sum(this.cells, this.keySizes.length, (cell) => cell.key);
  }

  get responseShared(): number[] {
    return sum(this.cells, this.responseSizes.length, (cell) => cell.response);
  }
}

function indexOf(partition: Partition): Map<string, number> {
  const index = new Map<string, number>();
  for (const entity of partition.values())
    if (!index.has(entity)) index.set(entity, index.size);
  return index;
}

function sizes(
  partition: Partition,
  index: ReadonlyMap<string, number>,
): number[] {
  const counts = new Array<number>(index.size).fill(0);
  for (const entity of partition.values()) counts[index.get(entity)!]!++;
  return counts;
}

function sum(
  cells: Contingency['cells'],
  length: number,
  of: (cell: Contingency['cells'][number]) => number,
): number[] {
  const totals = new Array<number>(length).fill(0);
  for (const cell of cells) totals[of(cell)]! += cell.count;
  return totals;
}
