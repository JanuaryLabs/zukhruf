import type { Fusion, RankedDoc } from './fusion.ts';
import type { Passage } from './passage.ts';
import type { RankedPassage } from './ranked-passage.ts';
import type { ScoredPassage } from './scored-passage.ts';

/** A list of passages as a composite retriever got it, with its name and weight. */
export type PassageList<P extends Passage, F> = {
  readonly name: string;
  readonly weight: number;
  readonly passages: readonly (RankedPassage<P> & F)[];
};

/**
 * Fuses lists of passages on `Passage.id`, as Elasticsearch, OpenSearch and
 * Qdrant fuse ids and attach documents after (ADR 0007): each list becomes
 * one input of the fusion, the fusion gives the ids best first with their
 * scores, and each id gets the passage of the first list that holds it and
 * the first vector that a list gives (ADR 0007, 2026-11-23). An id that no
 * list holds, which only a host fusion can give, has no passage to attach,
 * so it is a `TypeError`.
 */
export function fusePassages<P extends Passage, F>(
  fusion: Fusion<RankedDoc & F>,
  lists: readonly PassageList<P, F>[],
): ScoredPassage<P>[] {
  const fused = fusion.fuse(
    lists.map(({ name, weight, passages }) => ({
      name,
      weight,
      docs: passages.map((item) => ({ ...item, id: item.passage.id })),
    })),
  );
  const found = new Map<string, Found<P>>();
  for (const { passages } of lists) {
    for (const { passage, vector } of passages) {
      const entry = found.get(passage.id);
      if (entry === undefined) found.set(passage.id, { passage, vector });
      else entry.vector ??= vector;
    }
  }
  return fused.map(({ id, score }) => {
    const entry = found.get(id);
    if (entry === undefined) {
      throw new TypeError(
        `The fusion gave ${id}, which no list holds: a fusion gives only the ids of its inputs`,
      );
    }
    const { passage, vector } = entry;
    return vector === undefined
      ? { passage, score }
      : { passage, score, vector };
  });
}

type Found<P extends Passage> = {
  readonly passage: P;
  vector: RankedPassage['vector'];
};
