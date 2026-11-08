import type { Counts } from '../aggregation/counts.ts';
import type { Label } from './label.ts';

// The classes that an average reads: the counts of each class of the class
// set, in its order. A set of classes (multilabel) is not a class with two
// labels (binary).
export type Classes = {
  readonly counts: ReadonlyMap<Label, Counts>;
  readonly multilabel: boolean;
};

// How the scores of the classes become one number (Strategy), as the
// average of scikit-learn's precision_recall_fscore_support. score gives the
// score of the counts of one class.
export interface Average {
  of(classes: Classes, score: (counts: Counts) => number): number;
}
