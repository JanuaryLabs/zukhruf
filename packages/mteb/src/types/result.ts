// mteb/types/_result.py.

// The name of a subset of a dataset, such as "en-de" or "default".
export type HFSubset = string;

// The name of a split of a dataset, such as "test".
export type SplitName = string;

// A score value or a value that a scores dict carries beside its scores. It
// must survive a JSON round trip.
export type Score =
  | number
  | string
  | boolean
  | null
  | readonly Score[]
  | { readonly [key: string]: Score };

export type ScoresDict = Readonly<Record<string, Score>>;

export type RetrievalEvaluationResult = {
  // For each query id, each trec_eval measure ("ndcg_cut_10", "P_5", ...).
  readonly allScores: ReadonlyMap<string, Readonly<Record<string, number>>>;
  readonly ndcg: Readonly<Record<string, number>>;
  readonly map: Readonly<Record<string, number>>;
  readonly recall: Readonly<Record<string, number>>;
  readonly precision: Readonly<Record<string, number>>;
  readonly naucs: Readonly<Record<string, number>>;
  readonly mrr: Readonly<Record<string, number>>;
  readonly naucsMrr: Readonly<Record<string, number>>;
  readonly hitRate: Readonly<Record<string, number>>;
};
