# @zukhruf/evals

> **Status: design for review.** This README is the API on paper. No code exists yet. The decisions are in [ADR 0001](docs/adr/0001-one-package-with-a-subpath-for-each-shape-of-answer.md), [ADR 0002](docs/adr/0002-the-core-is-generic-over-the-answer.md) and [ADR 0003](docs/adr/0003-classification-follows-scikit-learn-from-the-counts-of-each-class.md).

An eval sends inputs to a harness and scores each answer against its label. This package scores the answers. It does not run the harness, load the dataset, store the results or show them. A runner does that work, and the package has an adapter for promptfoo.

The answers of evals have different shapes: a structured record, a label, a ranked list, a partition. Each shape has its own rules, so each shape has its own subpath. All subpaths share one core: a scorer gives a ratio for one answer, and a runner adds the ratios of many answers. The words are defined in [CONTEXT.md](CONTEXT.md).

## The parts

| Import path                         | Job                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@zukhruf/evals`                    | The core: scorers, ratios, gates, scorer sets, scorecards, totals and bootstrap intervals.                  |
| `@zukhruf/evals/promptfoo`          | The adapter that makes a scorer or a scorer set a promptfoo assertion.                                      |
| `@zukhruf/evals/structured`         | Compares a structured value with the value that a person labelled. Today: `@zukhruf/structured-eval`.       |
| `@zukhruf/evals/classification`     | Compares the stated labels of an answer with its expected labels, as scikit-learn's `sklearn.metrics` does. |
| `@zukhruf/evals/ranking` (later)    | Compares a ranked list with judged items, as trec_eval does.                                                |
| `@zukhruf/evals/clustering` (later) | Compares a partition with a labelled partition, as the CoNLL reference scorer does.                         |

A subpath imports only the core. It never imports another subpath.

## Score one answer

A family compares a stated answer with its case. The result is the input of its scorers: a `Comparison` in `./structured`, a `LabelComparison` in `./classification`. A scorer reads that input and gives one `Ratio`.

```ts
import { F1, Precision, Recall } from '@zukhruf/evals';
import {
  ClassMatches,
  LabelComparer,
  LabelVarsCase,
} from '@zukhruf/evals/classification';

const comparer = new LabelComparer();
const testCase = new LabelVarsCase().from({ expected: 'program' });
const comparison = comparer.compare('home', testCase);

new Recall(new ClassMatches('program')).score(comparison); // Ratio { part: 0, whole: 1 }
new Precision(new ClassMatches('home')).score(comparison); // Ratio { part: 0, whole: 1 }
```

A `Ratio` is a part and a whole. Its value is the part divided by the whole, and 0 when the whole is 0. `Precision`, `Recall`, `F1` and `FBeta` read the counts of a `Matches`: the hits, the stated and the expected. Each family gives its own matches, and these scorers take any of them.

## Combine scorers

A penalty is a factor in [0, 1] for one input, as BLEU's brevity penalty is. The factor 1 is no penalty. A penalty is also a scorer: its ratio is `Ratio(factor, 1)`. A gate is the penalty whose factor is 0 or 1. A gate says what it checks (`holds`) and why it fails (`explain`).

- `new Penalized(scorer, ...penalties)` multiplies the part of the ratio by each factor. The whole stays, so a failed answer keeps its place in the denominator.
- `new AtLeast(scorer, threshold)` is a gate that holds when the value of the scorer reaches the threshold.
- `new ShortfallPenalty(scorer, { target, power })` gives `min(1, (value / target) ** power)`: 1 at the target, and less below it.
- `new SampleAveraged(scorer, { whenEmpty })` gives the value of the scorer over 1. `whenEmpty` is the value of an answer whose ratio has the whole 0.
- `new MeanOf(...scorers)` gives the mean of the values of some scorers for one answer.

## Score with many scorers at once

A `ScorerSet` holds labelled scorers and gives a `Scorecard`: passed, reason, checks and one named ratio for each label. It passes when each of its gates holds. The family's comparer makes the input once, and each scorer reads it.

```ts
import { Recall, ScorerSet } from '@zukhruf/evals';
import {
  AllClassMatches,
  LabelComparer,
  LabelsMatch,
} from '@zukhruf/evals/classification';

const pageKinds = new ScorerSet(
  {
    accuracy: new LabelsMatch(),
    recall: new Recall(new AllClassMatches()),
  },
  { comparer: new LabelComparer() },
);
```

## Add up many answers

`Totals` adds the ratios of many scorecards, name by name: the sum of the parts divided by the sum of the wholes. So the scorer decides the average:

- A plain scorer gives its counts, such as Ratio(2, 3). `Totals` then gives the micro average.
- A `SampleAveraged` scorer gives its value over 1. `Totals` then gives the samples average: the mean of the values of the answers.

`Bootstrap` gives the interval of one name over the scorecards, with `@zukhruf/statistics`. You give it the number of resamples, the random index and the method of the interval.

## Compare structured values

`./structured` is `@zukhruf/structured-eval`, after the six slices of backlog #3884 ([its ADR 0011](../structured-eval/docs/adr/0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md)). Its API is in [its README](../structured-eval/README.md): `ComparisonSpec`, `TreeWalk`, `Comparison`, `PathMatches`, `ValueMatches`, `ItemMatches`, `TokenF1`, `TypePrecision`, `RequiredKeyRecall`, its gates, `PerField`, `JsonSchema`, `ConfigCase` and `TextVarsCase`. The move changes the import paths. It does not change the API (backlog #3888).

## Score labels

`./classification` compares the stated labels of an answer with its expected labels. One label is a set of one label, so one model serves a class (multiclass) and a set of classes (multilabel). The arithmetic follows scikit-learn 1.9.1, bit for bit.

### For each answer

`LabelComparer` reads the stated labels from the answer and gives a `LabelComparison`. Its matches count one answer:

| Matches                   | Hits                             | Stated                   | Expected               |
| ------------------------- | -------------------------------- | ------------------------ | ---------------------- |
| `new ClassMatches(label)` | 1 when both sides have the label | 1 when the answer has it | 1 when the case has it |
| `new AllClassMatches()`   | the labels that both sides have  | the stated labels        | the expected labels    |

`LabelsMatch` is a gate: it holds when the stated labels are the expected labels. `Totals` of its ratios gives the accuracy (for a set of classes: the subset accuracy of scikit-learn). `new PerClass(scorer, { labels })` gives one ratio for each class, under the label `${class} ${label}`.

So a promptfoo run gives the micro precision, recall and F1, and the precision and recall of each class, in its column headers.

### For a whole run

A macro or weighted average is not a ratio of sums: it takes the value of each class first. `ClassCounts` keeps the counts of each class (true positives, predicted, true), as scikit-learn's `multilabel_confusion_matrix` gives them. Add each comparison, then read the metrics:

```ts
import {
  ClassCounts,
  CountsForm,
  MacroAverage,
  WeightedAverage,
} from '@zukhruf/evals/classification';

const counts = new ClassCounts();
for (const comparison of comparisons) counts.add(comparison);

counts.accuracy(); // accuracy_score
counts.fBeta({ beta: 1, average: new MacroAverage() }); // f1_score(average='macro')
counts.precision({ average: new WeightedAverage() }); // precision_score(average='weighted')
counts.fBeta({
  beta: 0.5,
  average: new MacroAverage(),
  form: new CountsForm(),
});
counts.confusionMatrix(); // confusion_matrix, labels in sorted order
```

- `average` is a Strategy: `new MicroAverage()`, `new MacroAverage()`, `new WeightedAverage()` or `new BinaryAverage(positiveLabel)`. The samples average is a `SampleAveraged` scorer, because it needs the value of each answer.
- `zeroDivision` is the value of a class score whose denominator is 0: 0 (the default, as scikit-learn's `"warn"` gives), 1 or `NaN`.
- `form` is the arithmetic of the F-measure (ADR 0003). `new CountsForm()` is scikit-learn's and the default. `new ErrorsForm()` is torchmetrics' and TREC's. `new PrecisionRecallForm()` is van Rijsbergen's and SOB's.
- `ClassCounts.of(stated, expected)` builds the counts from two arrays of labels, as a batch.

### Probabilities

`BrierScore` compares the stated probability of each class with the expected labels, as scikit-learn's `brier_score_loss` does. Its ratio is the score of one answer over 1, so `Totals` gives the mean.

## Use it with promptfoo

`PromptfooAssertion` adapts a scorer set to a per-row assertion. Each ratio becomes a named score with its whole as the weight, so the column header shows the same ratio of sums as `Totals`. It reads the case from the config of the assertion.

`ScorerAssertion` holds one scorer with its `weight` (how much it counts in the score of the test) and its `threshold` (when it passes). Both numbers are required. It reads the case from the vars of the test.

promptfoo stores the config of a run as JSON, and `--resume` and `--retry-errors` build the run from that stored config. A function does not survive JSON, so a config holds no scorer assertion. An `AssertionModule` holds the scorer assertions by name, in a module that promptfoo loads. Its `assert(...names)` gives JSON assertions whose `value` is the file reference `file://<module>:<name>`. promptfoo loads the function from the default export of the module when it grades, on the first run and on a resumed run (structured-eval ADR 0013).

```ts
// page-kinds/scorers.ts: the module that promptfoo loads
import { Recall } from '@zukhruf/evals';
import {
  AllClassMatches,
  LabelComparer,
  LabelVarsCase,
  LabelsMatch,
} from '@zukhruf/evals/classification';
import { AssertionModule, ScorerAssertion } from '@zukhruf/evals/promptfoo';

const labels = { comparer: new LabelComparer(), cases: new LabelVarsCase() };

export const scorers = new AssertionModule(import.meta.url, {
  accuracy: new ScorerAssertion(new LabelsMatch(), {
    weight: 1,
    threshold: 1,
    ...labels,
  }),
  recall: new ScorerAssertion(new Recall(new AllClassMatches()), {
    weight: 0,
    threshold: 0,
    ...labels,
  }),
});
export default scorers.functions;
```

```ts
// page-kinds/promptfooconfig.ts
import type { UnifiedConfig } from 'promptfoo';

import { scorers } from './scorers.ts';

export default {
  defaultTest: { assert: scorers.assert('accuracy', 'recall') },
} satisfies UnifiedConfig;
```

The name is the promptfoo `metric`, unless the scorer assertion gives its own `metric`. A name that the module does not hold is a compile error. promptfoo shows the mean of each `metric` over the tests. A `ScorerAssertion` gives one value for one test, so a micro average needs `PromptfooAssertion`, whose ratios keep their wholes.

## What the package does not do

- It does not run a harness, load a dataset, store results or show them. promptfoo does that.
- It has no benchmark. A benchmark, such as SOB, is a composition of scorers that its caller keeps.
- It has no LLM judge.
- A subpath never imports another subpath.

## The same concepts in other systems

| This package                                       | Other systems                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Scorer (one answer), metric (many answers)         | Inspect AI: `@scorer` and `@metric`                                                            |
| A subpath for each shape of answer                 | torchmetrics: `classification/`, `retrieval/`, `clustering/`; `@mastra/evals/scorers/prebuilt` |
| `ClassCounts`: add, then compute                   | torchmetrics: `update()` and `compute()` over `tp`, `fp`, `tn`, `fn`                           |
| `average`, `zeroDivision`, `beta`                  | scikit-learn: `average=`, `zero_division=`, `beta=`                                            |
| `ScorerAssertion`: `metric`, `weight`, `threshold` | promptfoo: the fields of an assertion                                                          |
| `AssertionModule`: `file://<module>:<name>`        | promptfoo: a `javascript` assertion whose `value` is a file reference                          |
| Optional peers of a subpath                        | torchmetrics extras, such as `torchmetrics[text]`                                              |

## API

```ts
// @zukhruf/evals: the core

/** A part and a whole. Its value is part / whole, and 0 when the whole is 0. */
export class Ratio {
  constructor(part: number, whole: number);
  readonly part: number;
  readonly whole: number;
  get value(): number;
  times(weight: number): Ratio;
}

/** Gives one ratio for one input. It keeps no result. */
export interface Scorer<Input> {
  score(input: Input): Ratio;
}

/** The counts of one input that precision, recall and F1 read. */
export interface Matches<Input> {
  of(input: Input): { hits: number; stated: number; expected: number };
}

export class Precision<Input> implements Scorer<Input> {
  constructor(matches: Matches<Input>);
}
export class Recall<Input> implements Scorer<Input> {
  constructor(matches: Matches<Input>);
}
/** Its part is (1 + β²) × hits and its whole is β² × expected + stated. Its value comes from its form. */
export class FBeta<Input> implements Scorer<Input> {
  constructor(
    matches: Matches<Input>,
    options: { beta: number; form?: FMeasureForm },
  );
}
/** FBeta with β = 1: its part is 2 × hits and its whole is expected + stated. */
export class F1<Input> implements Scorer<Input> {
  constructor(matches: Matches<Input>, options?: { form?: FMeasureForm });
}

/** The arithmetic of the value of an F-measure (ADR 0003). */
export interface FMeasureForm {
  of(
    counts: { hits: number; stated: number; expected: number },
    beta: number,
  ): number;
}
export class CountsForm implements FMeasureForm {}
export class ErrorsForm implements FMeasureForm {}
export class PrecisionRecallForm implements FMeasureForm {}

/** A factor in [0, 1] for one input; its ratio is Ratio(factor, 1) (Template Method). */
export abstract class Penalty<Input> implements Scorer<Input> {
  protected abstract factor(input: Input): number;
}
/** The penalty whose factor is 1 when it holds, else 0. */
export abstract class Gate<Input> extends Penalty<Input> {
  protected abstract holds(input: Input): boolean;
  abstract explain(input: Input): string;
}
/** Multiplies the part of the ratio of its scorer by each factor; the whole stays (Decorator). */
export class Penalized<Input> implements Scorer<Input> {
  constructor(scorer: Scorer<Input>, ...penalties: Penalty<Input>[]);
}
export class AtLeast<Input> extends Gate<Input> {
  constructor(scorer: Scorer<Input>, threshold: number);
}
/** min(1, (value / target) ** power). */
export class ShortfallPenalty<Input> extends Penalty<Input> {
  constructor(
    scorer: Scorer<Input>,
    options: { target: number; power: number },
  );
}
export class SampleAveraged<Input> implements Scorer<Input> {
  constructor(scorer: Scorer<Input>, options: { whenEmpty: number });
}
export class MeanOf<Input> implements Scorer<Input> {
  constructor(...scorers: Scorer<Input>[]);
}

/** What one test gives a scorer besides the stated answer. */
export interface Weighted {
  readonly weight: number;
}
/** Reads a case from the plain object that a runner holds for one test (Strategy). */
export interface CaseReader<Case extends Weighted> {
  from(source: Readonly<Record<string, unknown>>): Case;
}
/** Compares a stated answer with its case, and gives the input of the scorers of a family. */
export interface Comparer<Case extends Weighted, Input> {
  compare(stated: unknown, testCase: Case): Input;
}

export type Check = {
  readonly passed: boolean;
  readonly score: number;
  readonly reason: string;
};
export type Scorecard = {
  readonly passed: boolean;
  readonly score: number;
  readonly reason: string;
  readonly checks: readonly Check[];
  readonly ratios: ReadonlyMap<string, Ratio>;
};
/** Scores one stated answer against its case and gives a scorecard. */
export interface ScorecardScorer<Case extends Weighted> {
  score(stated: unknown, testCase: Case): Scorecard;
}
export class ScorerSet<
  Case extends Weighted,
  Input,
> implements ScorecardScorer<Case> {
  constructor(
    scorers: Readonly<Record<string, Scorer<Input>>>,
    options: { comparer: Comparer<Case, Input> },
  );
}

/** The ratio of sums of each name over many scorecards. */
export class Totals {
  add(scorecard: Scorecard, weight?: number): void;
  get(name: string): Ratio;
  names(): string[];
}
/** The interval of one name over weighted scorecards (@zukhruf/statistics). */
export class Bootstrap {
  constructor(options: {
    nResamples: number;
    randomIndex: (n: number) => number;
    interval: ConfidenceIntervalMethod;
  });
  interval(
    rows: readonly { scorecard: Scorecard; weight: number }[],
    name: string,
  ): ConfidenceInterval;
}

// @zukhruf/evals/promptfoo

export class PromptfooAssertion<Case extends Weighted> {
  constructor(scorer: ScorecardScorer<Case>, cases: CaseReader<Case>);
  readonly grade: (
    output: unknown,
    context: { config?: Readonly<Record<string, unknown>> },
  ) => GradingResult;
}
/** One scorer with its weight and threshold. It is not a promptfoo assertion: an AssertionModule gives it to promptfoo. */
export class ScorerAssertion<Case extends Weighted, Input> {
  constructor(
    scorer: Scorer<Input>,
    options: {
      weight: number;
      threshold: number;
      metric?: string;
      comparer: Comparer<Case, Input>;
      cases: CaseReader<Case>;
    },
  );
  readonly metric: string | undefined;
  readonly weight: number;
  readonly threshold: number;
  readonly value: (
    output: string,
    context: { vars: Readonly<Record<string, unknown>> },
  ) => number;
}
/** A promptfoo javascript assertion that holds only JSON. */
export type FileAssertion = {
  readonly type: 'javascript';
  readonly metric: string;
  readonly weight: number;
  readonly threshold: number;
  readonly value: string; // file://<module>:<name>
};
/** The module that promptfoo loads the function of each scorer assertion from (structured-eval ADR 0013). */
export class AssertionModule<Name extends string> {
  constructor(
    url: string,
    assertions: Readonly<Record<Name, ScorerAssertion<Weighted, unknown>>>,
  );
  /** The default export of the module: the value function of each name. */
  readonly functions: Readonly<
    Record<string, ScorerAssertion<Weighted, unknown>['value']>
  >;
  assert(...names: Name[]): FileAssertion[];
}

// @zukhruf/evals/classification

/** A label: an int or a string, as scikit-learn reads a label. */
export type Label = number | string;

/** The expected labels of one test, and its weight. */
export class LabelCase implements Weighted {
  constructor(expected: Label | readonly Label[], weight?: number);
  readonly expected: ReadonlySet<Label>;
  readonly weight: number;
}
/** Reads `vars.expected` (a label or a list of labels) and `vars.weight`. */
export class LabelVarsCase implements CaseReader<LabelCase> {}
/** Reads `config.expected`. */
export class LabelConfigCase implements CaseReader<LabelCase> {}

export class LabelComparison {
  readonly stated: ReadonlySet<Label>;
  readonly expected: ReadonlySet<Label>;
}
/** Reads the stated labels of an answer: a label, a list of labels, or their JSON text. */
export class LabelComparer implements Comparer<LabelCase, LabelComparison> {
  constructor(options?: { normalize?: (label: string) => string });
}

export class ClassMatches implements Matches<LabelComparison> {
  constructor(label: Label);
}
export class AllClassMatches implements Matches<LabelComparison> {}
/** Holds when the stated labels are the expected labels. */
export class LabelsMatch extends Gate<LabelComparison> {}
export class PerClass<Input> {
  constructor(scorer: Scorer<Input>, options: { labels: readonly Label[] });
}

/** How the scores of the classes become one number (Strategy). */
export interface Average {}
export class MicroAverage implements Average {}
export class MacroAverage implements Average {}
export class WeightedAverage implements Average {}
export class BinaryAverage implements Average {
  constructor(positiveLabel: Label);
}

/** The counts of each class over many answers: true positives, predicted and true. */
export class ClassCounts {
  static of(
    stated: readonly (Label | readonly Label[])[],
    expected: readonly (Label | readonly Label[])[],
  ): ClassCounts;
  add(comparison: LabelComparison): void;
  labels(): Label[];
  accuracy(): number;
  precision(options: {
    average: Average;
    zeroDivision?: number;
    labels?: readonly Label[];
  }): number;
  recall(options: {
    average: Average;
    zeroDivision?: number;
    labels?: readonly Label[];
  }): number;
  fBeta(options: {
    beta: number;
    average: Average;
    zeroDivision?: number;
    labels?: readonly Label[];
    form?: FMeasureForm;
  }): number;
  support(): ReadonlyMap<Label, number>;
  confusionMatrix(): ConfusionMatrix;
}
export class ConfusionMatrix {
  readonly labels: readonly Label[];
  count(expected: Label, stated: Label): number;
  rows(): number[][];
}

/** The stated probability of each class of one answer. */
export class ProbabilityComparison {
  readonly probabilities: ReadonlyMap<Label, number>;
  readonly expected: ReadonlySet<Label>;
}
export class BrierScore implements Scorer<ProbabilityComparison> {}
```

## Who uses each part

The consumers below come from the search of 2026-11-06 (eight evals in four repositories). Each consumer changes to follow the package in its own backlog item.

| Consumer                                     | Uses                                                                                               | Backlog                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| offers-evals (SOB and the offers eval)       | core, `./structured`, `./promptfoo`                                                                | offers-evals #3892            |
| context-compiler, startup-credits offers     | core, `./structured` (`ByBestMatch`), `./promptfoo`                                                | context-compiler #3893, #3882 |
| context-compiler, startup-credits page kinds | `./classification` (accuracy, the precision and recall of each class, the confusion matrix)        | #3882 slice 2                 |
| `@zukhruf/mteb`, classification tasks        | `./classification` (`ClassCounts`: accuracy, macro and weighted P, R and F1; label-indicator rows) | mutex #3890                   |
| relevance-filtering eval                     | `./classification` (`BinaryAverage`, F0.5 with `ErrorsForm`, `BrierScore`)                         | mutex #3891                   |
| event-detection eval                         | nothing yet: its MUC, B³, CEAF-e and BLANC wait for `./clustering`                                 | —                             |

The build is in two items: mutex #3888 (the core, `./promptfoo` and the move of `./structured`) and mutex #3889 (`./classification`).

## Documentation

- [ADR 0001: one package, with a subpath for each shape of answer](docs/adr/0001-one-package-with-a-subpath-for-each-shape-of-answer.md)
- [ADR 0002: the core is generic over the answer](docs/adr/0002-the-core-is-generic-over-the-answer.md)
- [ADR 0003: classification follows scikit-learn, from the counts of each class](docs/adr/0003-classification-follows-scikit-learn-from-the-counts-of-each-class.md)
