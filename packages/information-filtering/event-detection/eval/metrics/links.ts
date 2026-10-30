import type { Contingency } from './contingency.ts';

// The pairs of mentions. A coreference link joins two mentions of one
// entity; a non-coreference link joins two mentions of two entities.
export type Links = {
  // Coreference links of the key, of the response, and of both.
  readonly key: number;
  readonly response: number;
  readonly both: number;
};

export function coreferenceLinks(table: Contingency): Links {
  return {
    key: pairsIn(table.keySizes),
    response: pairsIn(table.responseSizes),
    both: pairsIn(table.cells.map((cell) => cell.count)),
  };
}

// Two mentions that both partitions have, in two key entities and in two
// response entities, are a non-coreference link of both.
export function nonCoreferenceLinks(table: Contingency): Links {
  const shared = table.keyShared;
  const common = shared.reduce((total, count) => total + count, 0);
  const mentions = (sizes: readonly number[]) =>
    sizes.reduce((total, size) => total + size, 0);
  const coreference = coreferenceLinks(table);
  return {
    key: pairs(mentions(table.keySizes)) - coreference.key,
    response: pairs(mentions(table.responseSizes)) - coreference.response,
    both:
      pairs(common) -
      pairsIn(shared) -
      pairsIn(table.responseShared) +
      coreference.both,
  };
}

function pairsIn(sizes: readonly number[]): number {
  return sizes.reduce((total, size) => total + pairs(size), 0);
}

function pairs(size: number): number {
  return (size * (size - 1)) / 2;
}
