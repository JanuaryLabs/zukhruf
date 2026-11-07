import type { Counts } from '../aggregation/counts.ts';
import type { Label } from './label.ts';

// The classes that an average reads: the counts of the classes that the
// caller selects, in their order, and of every class of the answers. A set of
// classes (multilabel) is not a class with two labels (binary).
export type Classes = {
  readonly selected: ReadonlyMap<Label, Counts>;
  readonly present: ReadonlyMap<Label, Counts>;
  readonly multilabel: boolean;
};

// How the scores of the classes become one number (Strategy), as the
// average of scikit-learn's precision_recall_fscore_support. score gives the
// score of the counts of one class.
export interface Average {
  of(classes: Classes, score: (counts: Counts) => number): number;
}
