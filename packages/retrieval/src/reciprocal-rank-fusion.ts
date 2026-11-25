import { sumOnId } from './sum-on-id.ts';

/**
 * Gives each passage the sum of `weight / (k + rank)` over the lists that
 * hold it, with ranks from 1 (Cormack, Clarke and Büttcher, SIGIR 2009;
 * LangChain `EnsembleRetriever`, `weight / (rank + this.c)`). The scores of
 * the lists are not read, only their order (ADR 0007), so a list of order
 * only, without scores, fuses like any other (ADR 0016). `k` is an integer
 * of 1 or more, as Elasticsearch's `rank_constant` is (ADR 0007, amendment
 * 2026-11-25).
 */
export function reciprocalRankFusion({ k = 60 }: { readonly k?: number } = {}) {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(
      `The k of reciprocal rank fusion is an integer of 1 or more, not ${k}`,
    );
  }
  return sumOnId((list) => list.map((_, rank) => 1 / (k + rank + 1)));
}
