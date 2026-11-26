import type { Fusion, RankedDoc } from './fusion.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { Rescored } from './scored-passage.ts';

/** A list of items as a composite retriever got it, with its name and weight. */
export type PassageList<I extends RankedPassage> = {
  readonly name: string;
  readonly weight: number;
  readonly passages: readonly I[];
};

/**
 * Fuses lists of items on `Passage.id`, as Elasticsearch, OpenSearch and
 * Qdrant fuse ids and attach documents after (ADR 0007): each list becomes
 * one input of the fusion, the fusion gives the ids best first with their
 * scores, and each id gets the item of the first list that holds it, with
 * every field of that item but its score, which the fusion gives, and the
 * first vector that a list gives (ADR 0007, 2026-11-23; ADR 0024). An id
 * that no list holds, which only a host fusion can give, has no item to
 * attach, so it is a `TypeError`.
 */
export function fusePassages<I extends RankedPassage, F>(
  fusion: Fusion<RankedDoc & F>,
  lists: readonly PassageList<I & F>[],
): Rescored<I>[] {
  const fused = fusion.fuse(
    lists.map(({ name, weight, passages }) => ({
      name,
      weight,
      docs: passages.map((item) => ({ ...item, id: item.passage.id })),
    })),
  );
  const found = new Map<string, Found<I>>();
  for (const { passages } of lists) {
    for (const item of passages) {
      const entry = found.get(item.passage.id);
      if (entry === undefined) {
        found.set(item.passage.id, { item, vector: item.vector });
      } else entry.vector ??= item.vector;
    }
  }
  return fused.map(({ id, score }) => {
    const entry = found.get(id);
    if (entry === undefined) {
      throw new TypeError(
        `The fusion gave ${id}, which no list holds: a fusion gives only the ids of its inputs`,
      );
    }
    const { item, vector } = entry;
    return vector === undefined
      ? { ...item, score }
      : { ...item, score, vector };
  });
}

type Found<I extends RankedPassage> = {
  readonly item: I;
  vector: RankedPassage['vector'];
};
