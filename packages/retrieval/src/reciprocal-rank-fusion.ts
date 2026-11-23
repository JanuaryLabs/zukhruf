import type { Fusion } from './fusion.ts';
import { sumOnId } from './sum-on-id.ts';

/**
 * Gives each passage the sum of `weight / (k + rank)` over the lists that
 * hold it, with ranks from 1 (Cormack, Clarke and Büttcher, SIGIR 2009;
 * LangChain `EnsembleRetriever`, `weight / (rank + this.c)`). The scores of
 * the lists are not read, only their order (ADR 0007).
 */
export function reciprocalRankFusion({
  k = 60,
}: { readonly k?: number } = {}): Fusion {
  return {
    fuse: (lists, weights) =>
      sumOnId(lists, weights, (scores) =>
        scores.map((_, index) => 1 / (k + index + 1)),
      ),
  };
}
