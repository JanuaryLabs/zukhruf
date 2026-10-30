import { compareStrings } from './python.ts';

// pytrec_eval 0.5.11 (RelevanceEvaluator) and the trec_eval 9.0.8 measures
// that MTEB asks it for. trec_eval stores a score as a C float, so scores
// compare as float32 values, and equal scores rank the greater document id
// first (form_res_rels.c, comp_sim_docno).

// trec_eval.h: a retrieved document that the qrels do not judge.
const NONPOOL = -1;
// trec_eval.h: a judged document with a negative relevance.
const UNJUDGED = -2;

type Measure = {
  readonly name: string;
  // The cutoffs, in increasing order; null for a measure without cutoffs.
  readonly cutoffs: readonly number[] | null;
};

// The measures in the order of trec_eval's measure table (measures.c).
const MEASURES: Readonly<
  Record<
    string,
    {
      readonly index: number;
      readonly defaults: readonly number[] | null;
      readonly calculate: (
        rels: RelevanceRanking,
        cutoffs: readonly number[],
        relevanceLevel: number,
      ) => number[];
    }
  >
> = {
  recip_rank: { index: 10, defaults: null, calculate: reciprocalRank },
  P: {
    index: 12,
    defaults: [5, 10, 15, 20, 30, 100, 200, 500, 1000],
    calculate: precision,
  },
  recall: {
    index: 14,
    defaults: [5, 10, 15, 20, 30, 100, 200, 500, 1000],
    calculate: recall,
  },
  ndcg_cut: {
    index: 25,
    defaults: [5, 10, 15, 20, 30, 100, 200, 500, 1000],
    calculate: ndcgCut,
  },
  map_cut: {
    index: 26,
    defaults: [5, 10, 15, 20, 30, 100, 200, 500, 1000],
    calculate: mapCut,
  },
  success: { index: 28, defaults: [1, 5, 10], calculate: success },
};

// The relevance of each retrieved document by rank, and the number of judged
// documents at each relevance level (form_res_rels.c, RES_RELS).
type RelevanceRanking = {
  readonly relevances: readonly number[];
  readonly levels: readonly number[];
  readonly relevant: number;
};

export class RelevanceEvaluator {
  readonly #qrels: ReadonlyMap<string, readonly (readonly [string, number])[]>;
  readonly #measures: readonly Measure[];
  readonly #relevanceLevel: number;
  readonly #judgedDocsOnly: boolean;

  // measures are trec_eval measure names, with cutoffs after a dot:
  // "ndcg_cut.1,5,10".
  constructor(
    queryRelevance: ReadonlyMap<string, ReadonlyMap<string, number>>,
    measures: Iterable<string>,
    options: {
      readonly relevanceLevel?: number;
      readonly judgedDocsOnlyFlag?: boolean;
    } = {},
  ) {
    this.#relevanceLevel = options.relevanceLevel ?? 1;
    if (this.#relevanceLevel < 1)
      throw new Error('Argument relevance_level should be positive.');
    this.#judgedDocsOnly = options.judgedDocsOnlyFlag ?? false;
    this.#qrels = new Map(
      [...queryRelevance].map(([query, documents]) => [
        query,
        [...documents].sort(([left], [right]) => compareStrings(left, right)),
      ]),
    );
    this.#measures = [...measures]
      .map(parseMeasure)
      .sort(
        (left, right) =>
          (MEASURES[left.name]?.index ?? 0) -
          (MEASURES[right.name]?.index ?? 0),
      );
  }

  // The measures of each query of scores that the qrels judge, in the order
  // of scores.
  evaluate(
    scores: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): Map<string, Record<string, number>> {
    const evaluation = new Map<string, Record<string, number>>();
    for (const [query, documents] of scores) {
      const qrels = this.#qrels.get(query);
      if (qrels === undefined) continue;
      const ranking = this.#rank(qrels, documents);
      const values: Record<string, number> = {};
      for (const { name, cutoffs } of this.#measures) {
        const calculated = MEASURES[name]?.calculate(
          ranking,
          cutoffs ?? [],
          this.#relevanceLevel,
        );
        if (cutoffs === null) values[name] = calculated?.[0] ?? 0;
        else
          for (const [index, cutoff] of cutoffs.entries())
            values[`${name}_${cutoff}`] = calculated?.[index] ?? 0;
      }
      evaluation.set(query, values);
    }
    return evaluation;
  }

  // te_form_res_rels.
  #rank(
    qrels: readonly (readonly [string, number])[],
    documents: ReadonlyMap<string, number>,
  ): RelevanceRanking {
    const judged = new Map(qrels);
    const ranked = [...documents]
      .map(([document, score]) => ({ document, sim: Math.fround(score) }))
      .sort(
        (left, right) =>
          right.sim - left.sim || compareStrings(right.document, left.document),
      )
      .map(({ document }) => {
        const relevance = judged.get(document);
        if (relevance === undefined) return NONPOOL;
        return relevance < 0 ? UNJUDGED : relevance;
      });
    const maxRelevance = Math.max(
      -1,
      ...qrels.map(([, relevance]) => relevance),
    );
    const levels = Array.from({ length: maxRelevance + 1 }, () => 0);
    for (const [, relevance] of qrels)
      if (relevance >= 0) levels[relevance] = (levels[relevance] ?? 0) + 1;
    let usedLevels = 0;
    let relevant = 0;
    for (const [level, count] of levels.entries())
      if (count > 0) {
        usedLevels = level + 1;
        if (level >= this.#relevanceLevel) relevant += count;
      }
    return {
      relevances: this.#judgedDocsOnly
        ? ranked.filter((relevance) => relevance >= 0)
        : ranked,
      levels: levels.slice(0, usedLevels),
      relevant,
    };
  }
}

function parseMeasure(measure: string): Measure {
  const [name = '', parameters] = measure.split('.', 2);
  const known = MEASURES[name];
  if (known === undefined)
    throw new Error(
      `Unsupported measure: ${measure}. This port supports ${Object.keys(MEASURES).join(', ')}.`,
    );
  if (known.defaults === null) return { name, cutoffs: null };
  if (parameters === undefined) return { name, cutoffs: known.defaults };
  const cutoffs = parameters
    .split(',')
    .map((cutoff) => Math.trunc(Number.parseInt(cutoff, 10) || 0))
    .sort((left, right) => left - right);
  if ((cutoffs[0] ?? 0) <= 0)
    throw new Error('trec_eval: Negative cutoff detected');
  if (cutoffs.some((cutoff, index) => cutoff === cutoffs[index - 1]))
    throw new Error('trec_eval: duplicate cutoffs detected');
  return { name, cutoffs };
}

// The value at each cutoff of a measure that walks the ranking once. step
// gives the running state after a rank; value turns the state into the value
// at a cutoff that the walk reaches at rank i (0 based).
function atCutoffs<State>(
  rels: RelevanceRanking,
  cutoffs: readonly number[],
  initial: State,
  step: (state: State, relevance: number, rank: number) => State,
  value: (state: State, cutoff: number) => number,
): number[] {
  const values = Array.from({ length: cutoffs.length }, () => 0);
  let state = initial;
  let cutoffIndex = 0;
  for (const [rank, relevance] of rels.relevances.entries()) {
    if (rank === cutoffs[cutoffIndex]) {
      values[cutoffIndex] = value(state, rank);
      if (++cutoffIndex === cutoffs.length) return values;
    }
    state = step(state, relevance, rank);
  }
  for (; cutoffIndex < cutoffs.length; cutoffIndex++)
    values[cutoffIndex] = value(state, cutoffs[cutoffIndex] ?? 0);
  return values;
}

// m_P.c.
function precision(
  rels: RelevanceRanking,
  cutoffs: readonly number[],
  relevanceLevel: number,
): number[] {
  return atCutoffs(
    rels,
    cutoffs,
    0,
    (found, relevance) => (relevance >= relevanceLevel ? found + 1 : found),
    (found, cutoff) => found / cutoff,
  );
}

// m_recall.c.
function recall(
  rels: RelevanceRanking,
  cutoffs: readonly number[],
  relevanceLevel: number,
): number[] {
  if (rels.relevant === 0) return cutoffs.map(() => 0);
  return atCutoffs(
    rels,
    cutoffs,
    0,
    (found, relevance) => (relevance >= relevanceLevel ? found + 1 : found),
    (found) => found / rels.relevant,
  );
}

// m_success.c.
function success(
  rels: RelevanceRanking,
  cutoffs: readonly number[],
  relevanceLevel: number,
): number[] {
  return atCutoffs(
    rels,
    cutoffs,
    0,
    (found, relevance) => (relevance >= relevanceLevel ? found + 1 : found),
    (found) => (found > 0 ? 1 : 0),
  );
}

// m_map_cut.c.
function mapCut(
  rels: RelevanceRanking,
  cutoffs: readonly number[],
  relevanceLevel: number,
): number[] {
  if (rels.relevant === 0) return cutoffs.map(() => 0);
  return atCutoffs(
    rels,
    cutoffs,
    { found: 0, sum: 0 },
    (state, relevance, rank) => {
      if (relevance < relevanceLevel) return state;
      const found = state.found + 1;
      return { found, sum: state.sum + found / (rank + 1) };
    },
    (state) => state.sum / rels.relevant,
  );
}

// m_recip_rank.c.
function reciprocalRank(
  rels: RelevanceRanking,
  _cutoffs: readonly number[],
  relevanceLevel: number,
): number[] {
  const rank = rels.relevances.findIndex(
    (relevance) => relevance >= relevanceLevel,
  );
  return [rank === -1 ? 0 : 1 / (rank + 1)];
}

// m_ndcg_cut.c: the gain of a document is its relevance, discounted by
// log2(rank + 1); the ideal ranking orders the judged documents by relevance.
function ndcgCut(rels: RelevanceRanking, cutoffs: readonly number[]): number[] {
  const values = atCutoffs(
    rels,
    cutoffs,
    0,
    (sum, gain, rank) => (gain > 0 ? sum + gain / Math.log2(rank + 2) : sum),
    (sum) => sum,
  );
  let cutoffIndex = 0;
  let level = rels.levels.length - 1;
  let levelCount = 0;
  let ideal = 0;
  for (let rank = 0; ; rank++) {
    levelCount++;
    while (level > 0 && levelCount > (rels.levels[level] ?? 0)) {
      level--;
      levelCount = 1;
    }
    if (level <= 0) break;
    if (rank === cutoffs[cutoffIndex]) {
      if (ideal > 0) values[cutoffIndex] = (values[cutoffIndex] ?? 0) / ideal;
      if (++cutoffIndex === cutoffs.length) return values;
    }
    ideal += level / Math.log2(rank + 2);
  }
  for (; cutoffIndex < cutoffs.length; cutoffIndex++)
    if (ideal > 0) values[cutoffIndex] = (values[cutoffIndex] ?? 0) / ideal;
  return values;
}
