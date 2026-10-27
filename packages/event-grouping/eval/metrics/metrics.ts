import { bCubed } from './b-cubed.ts';
import { blanc } from './blanc.ts';
import { ceafE } from './ceaf-e.ts';
import { Contingency, type Partition } from './contingency.ts';
import type { Score } from './f-measure.ts';
import { muc } from './muc.ts';
import { pair } from './pair.ts';

// The version of the metric set in scoreboard.json. A score of another
// version is not comparable: score that design again.
export const METRICS_VERSION = 2;

export type Metrics = {
  readonly muc: Score;
  readonly bCubed: Score;
  readonly ceafE: Score;
  readonly blanc: Score;
  readonly pair: Score;
  readonly conll: Conll;
};

// The CoNLL score (Pradhan et al. 2014, "Scoring coreference partitions of
// predicted mentions: A reference implementation"): the mean of the MUC,
// B-cubed and CEAF-e F. Its F0.5 is the main score (README.md).
export type Conll = { readonly f1: number; readonly f05: number };

export function metrics(key: Partition, response: Partition): Metrics {
  const table = new Contingency(key, response);
  const scores = {
    muc: muc(table),
    bCubed: bCubed(table),
    ceafE: ceafE(table),
  };
  return {
    ...scores,
    blanc: blanc(table),
    pair: pair(table),
    conll: conll(scores),
  };
}

// The main score: the CoNLL F0.5.
export function mainScore(key: Partition, response: Partition): number {
  const table = new Contingency(key, response);
  return conll({ muc: muc(table), bCubed: bCubed(table), ceafE: ceafE(table) })
    .f05;
}

function conll(scores: Pick<Metrics, 'muc' | 'bCubed' | 'ceafE'>): Conll {
  const mean = (f: 'f1' | 'f05') =>
    (scores.muc[f] + scores.bCubed[f] + scores.ceafE[f]) / 3;
  return { f1: mean('f1'), f05: mean('f05') };
}
