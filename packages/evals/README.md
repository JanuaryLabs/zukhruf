# @zukhruf/evals

An eval sends inputs to a harness and scores each answer against its label. This package scores the answers. It does not run the harness, load the dataset, store the results or show them. A runner does that work, and the package has an adapter for promptfoo.

The answers of evals have different shapes: a structured record, a label, a ranked list, a partition. Each shape has its own rules, so each shape has its own subpath. All subpaths share one core: a scorer gives a ratio for one answer, and a runner adds the ratios of many answers. The words are defined in [CONTEXT.md](CONTEXT.md).

## The parts

| Import path                         | Job                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@zukhruf/evals`                    | The core: scorers, ratios, gates, scorer sets, scorecards, totals and bootstrap intervals.                             |
| `@zukhruf/evals/promptfoo`          | The adapter that makes a scorer or a scorer set a promptfoo assertion.                                                 |
| `@zukhruf/evals/structured`         | Compares a structured value with the value that a person labelled.                                                     |
| `@zukhruf/evals/classification`     | Compares the stated labels of an answer with its expected labels, as scikit-learn's `sklearn.metrics` does (ADR 0003). |
| `@zukhruf/evals/ranking` (later)    | Compares a ranked list with judged items, as trec_eval does.                                                           |
| `@zukhruf/evals/clustering` (later) | Compares a partition with a labelled partition, as the CoNLL reference scorer does.                                    |

A subpath imports only the core. It never imports another subpath.

The core holds the parts that all families share: the ratios, the scorers, the penalties, `Comparer`, `Grouped`, `ScorerSet`, `Totals` and `Bootstrap`. A part that reads an input has a type parameter for that input. So a scorer of one family cannot read the input of another family (ADR 0002). `./promptfoo` holds `ScorerAssertion`. The families are `./structured` and `./classification`.

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

The ratio of `new FBeta(matches, { beta, form })` has the part (1 + β²) × hits and the whole β² × expected + stated, so many of them add up to the micro F-measure. `F1` is `FBeta` with β = 1. The form gives the value (ADR 0003):

- `new CountsForm()` is the default. It is scikit-learn's arithmetic, and its value is the part divided by the whole: 0 when the whole is 0. So 1 hit of 5 stated and 1 expected gives 1/3.
- `new PrecisionRecallForm()` is (1 + β²)·P·R / (β²·P + R): 0 when there are no hits. SOB's evaluate.py uses it. The same counts give 0.33333333333333337.

## Combine scorers

A penalty is a factor in [0, 1] for one input, as BLEU's brevity penalty is. The factor 1 is no penalty. A penalty is also a scorer: its ratio is `Ratio(factor, 1)`. A gate is the penalty whose factor is 0 or 1. A gate says what it checks (`holds`) and why it fails (`explain`).

- `new Penalized(scorer, ...penalties)` multiplies the part of the ratio by each factor. The whole stays, so a failed answer keeps its place in the denominator.
- `new AtLeast(scorer, threshold)` is a gate that holds when the value of the scorer reaches the threshold.
- `new ShortfallPenalty(scorer, { target, power })` gives `min(1, (value / target) ** power)`: 1 at the target, and less below it.
- `new SampleAveraged(scorer, { whenEmpty })` gives the value of the scorer over 1. `whenEmpty` is the value of an answer whose ratio has the whole 0.
- `new MeanOf(scorer, ...scorers)` gives the mean of the values of some scorers for one answer.

## Score with many scorers at once

A `ScorerSet` holds labelled scorers and gives a `Scorecard`: passed, reason, checks and one named ratio for each label. It passes when each of its gates holds. Each gate gives a check, whose `name` is the label of the gate. The `comparer` of the family is required, because the core cannot know a family: `new ScorerSet(scorers, { comparer: new LabelComparer() })`. It makes the input once, and each scorer reads it.

A grouped scorer gives one ratio for each group of an input, under the label `${group} ${label}`: `PerField` gives one for each field in `./structured`, and `PerClass` gives one for each class in `./classification`. Both extend `Grouped` of the core: a subclass gives its groups with `groups(input)`, and `ratios` drops a group whose whole is 0. So a `ScorerSet` holds them beside plain scorers (Inspect AI's `grouped()` applies a metric to each group in the same way).

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

`Totals` adds with CPython's compensated `sum()`. A sum of integer weights is exact, so its means and accuracies equal scikit-learn's for integer weights. A sum of float weights can differ from numpy's pairwise sum in the last bit. For float weights, use `ClassCounts` and `BrierScore.mean` of `./classification`.

`RatioOfSums.of(ratios)` adds a list of ratios in one call.

`Bootstrap` gives the interval of one name over the scorecards, with `@zukhruf/statistics`. You give it the number of resamples, the random index and the method of the interval.

## Compare two runs

Status: design for review (backlog #3870, [ADR 0004](docs/adr/0004-two-runs-are-compared-by-a-paired-bootstrap-over-their-tests.md)). The released package does not have `Run` or `PairedBootstrap` yet.

A caller runs one harness two times on the same tests: once with the baseline model and once with a change, such as another model. Two means side by side do not say if the change is better. `PairedBootstrap` gives one verdict for each name: better, worse or inconclusive, with the difference, its interval and a p-value.

```ts
import { PairedBootstrap, Run } from '@zukhruf/evals';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

const baseline = new Run();
const change = new Run();
for (const answer of baselineAnswers)
  baseline.add(
    answer.testId,
    scorer.score(answer.stated, answer.case),
    answer.case.weight,
  );
for (const answer of changeAnswers)
  change.add(
    answer.testId,
    scorer.score(answer.stated, answer.case),
    answer.case.weight,
  );

const generator = defaultRng(31957);
const paired = new PairedBootstrap({
  nResamples: 2000,
  randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
  interval: new PercentileInterval({
    low: 0.025,
    high: 0.975,
    method: new Linear(),
  }),
});

const recall = paired.verdict(baseline, change, 'recall', {
  higherIsBetter: true,
});
recall.result; // 'better', 'worse' or 'inconclusive'
recall.difference.observed; // Totals of the change minus Totals of the baseline
recall.difference.low; // the 2.5% quantile of the resample differences
recall.p; // the two-sided p-value of the same resamples
recall.improvements; // the tests whose value is higher in the change

const brier = paired.verdict(baseline, change, 'brier', {
  higherIsBetter: false,
});
```

A run holds the scorecards of one model. A second `add` of a test id is one more epoch of that test: startup-credits adds three runs of one model as three epochs of one `Run`. To test many names, call `verdict` once for each name, and correct the p-values, such as with `holm` of `@zukhruf/mteb`. To test one name, use its p-value as it is.

```ts
// @zukhruf/evals: two runs side by side (design for review)
import type {
  ConfidenceIntervalMethod,
  DifferenceInterval,
} from '@zukhruf/statistics';

/** The scorecards of one model on many tests. A test can have many epochs. */
export class Run {
  /** Adds one epoch of a test. Another weight for a test id that the run has is a RangeError. */
  add(testId: string, scorecard: Scorecard, weight: number): void;
}

export type Verdict = {
  readonly name: string;
  readonly result: 'better' | 'worse' | 'inconclusive';
  /** change − baseline: its observed value and its interval. */
  readonly difference: DifferenceInterval;
  /** The two-sided percentile-bootstrap p-value, with no correction. */
  readonly p: number;
  readonly improvements: number;
  readonly regressions: number;
  readonly ties: number;
  readonly tests: number;
};

/** The paired bootstrap of two runs on the same tests (Koehn 2004). */
export class PairedBootstrap {
  constructor(options: {
    nResamples: number;
    randomIndex: (n: number) => number;
    interval: ConfidenceIntervalMethod;
  });
  /** A test id in one run only, or a test with two weights, is a RangeError. A name that one run does not give is an Error. */
  verdict(
    baseline: Run,
    change: Run,
    name: string,
    options: { higherIsBetter: boolean },
  ): Verdict;
}
```

| Call                                        | What it does underneath                                                                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.add(testId, scorecard, weight)`        | Keeps the scorecard as one epoch of the test. The weight belongs to the case, so another weight for the same test id throws.                                                                                                           |
| `paired.verdict(baseline, change, …)`: join | Pairs the tests by test id, in the order in which the baseline run first got them. A test id in one run only throws, with each such id, as mteb's `pairedBootstrapTest` does. A test whose weight differs between the two runs throws. |
| reduce                                      | Takes the mean of the epochs of each test, name by name: Ratio(sum of the parts / k, sum of the wholes / k) for k epochs (Miller 2024, §3.1). A scorecard without the name counts as Ratio(0, 0), as in `Totals`.                      |
| resample                                    | `IidBootstrap` of `@zukhruf/statistics` draws the pairs of tests `nResamples` times. Each resample takes one `randomIndex` for each test.                                                                                              |
| statistic                                   | On the same resampled tests: the ratio of sums of the name over the change, minus the same over the baseline, with each weight (Koehn 2004). `difference.observed` is the same statistic on all the tests.                             |
| interval and verdict                        | The `ConfidenceIntervalMethod` gives the interval. With `higherIsBetter: true`, `isAbove(0)` is better and `isBelow(0)` is worse. With `false`, the two change places. Else the verdict is inconclusive.                               |
| p                                           | Two times the smaller share of the resample differences that are at or below 0 and at or above 0, at most 1, as mteb's `pairedBootstrapTest` gives it. The caller applies a correction, such as Holm.                                  |
| counts                                      | Counts the tests by the sign of (change value − baseline value), with the direction: improvements, regressions and ties.                                                                                                               |

`Bootstrap` and `PairedBootstrap` use different statistics. `Bootstrap` takes the mean of the values of the scorecards: the samples average. For a plain scorer, `Totals` gives the micro average, so the interval of `Bootstrap` is not the interval of the number of `Totals`. `PairedBootstrap` uses the statistic of `Totals`, so its interval is the interval of its observed difference (ADR 0004, "Consequences").

The design does not resample clustered tests, such as many questions about one page, and it reduces the epochs only by the mean.

| Who uses it                                               | For                                                                                    | Backlog                                     |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| context-compiler, startup-credits page kinds              | jev-1.14 against another model on the 121 pages, with the runs of each model as epochs | context-compiler #3882 slice 2, mutex #3870 |
| offers-evals and context-compiler, startup-credits offers | a run against the baseline run of its harness, for recall, precision, kind and amount  | mutex #3870, context-compiler #3882         |

## Compare structured values

`./structured` compares a structured value with the value that a person labelled: one walk pairs the leaves of the two values, the alignment of each array is a Strategy (by position, or by best match with the Hungarian algorithm), and each scorer gives a ratio for one record. SOB's evaluate.py is a configuration of the same scorers. [docs/structured.md](docs/structured.md) shows the whole API: `ComparisonSpec`, `TreeWalk`, `Comparison`, `PathMatches`, `ValueMatches`, `ItemMatches`, `TokenF1`, `TypePrecision`, `RequiredKeyRecall`, the gates, `PerField`, `JsonSchema`, `ConfigCase` and `TextVarsCase`. Its decisions are the ADRs in [docs/adr/structured](docs/adr/structured), from the time when it was `@zukhruf/structured-eval`.

It needs two optional peers: `npm install @zukhruf/evals @cfworker/json-schema munkres`.

## Score labels

`./classification` compares the stated labels of an answer with its expected labels. One label is a set of one label, so one model serves multiclass answers (one class) and multilabel answers (a set of classes). The arithmetic follows scikit-learn 1.9.1, bit for bit (ADR 0003). The golden tests compare each number with the output of `src/classification/fixtures/sklearn/generate.py`.

It needs no peer: `npm install @zukhruf/evals`. Its sums are `sum` and `mean` of `@zukhruf/statistics`, which give `numpy.sum` and `numpy.mean` bit for bit.

### For each answer

A case holds the expected labels and the weight: `new LabelCase({ expected, weight })`. `expected` is a label or a list of labels. `LabelVarsCase` reads `vars.expected` and `vars.weight` of a test (a test without a weight weighs 1). `LabelConfigCase` reads `config.expected` of an assertion, with the weight 1.

`LabelComparer` reads the stated labels of an answer and gives a `LabelComparison`. It reads a label or a list of labels as they are. It reads text in this order:

1. A JSON array of labels gives those labels.
2. A number gives a number label, but only when each expected label of the case is a number. So `"7"` matches the label `7` and the label `"7"`.
3. Other text is one string label, without its white space at the start and the end.

`comparison.only(label)` gives the comparison of one class: each side keeps the label when it has it.

The matches of a comparison count one answer:

| Matches                   | Hits                             | Stated                   | Expected               |
| ------------------------- | -------------------------------- | ------------------------ | ---------------------- |
| `new ClassMatches(label)` | 1 when both sides have the label | 1 when the answer has it | 1 when the case has it |
| `new AllClassMatches()`   | the labels that both sides have  | the stated labels        | the expected labels    |

`LabelsMatch` is a gate: it holds when the stated labels are the expected labels. `new PerClass(scorer, { labels })` gives one ratio for each class, under the label `${class} ${label}`. Without `labels`, the classes are the labels of both sides of the answer, in the order of numpy's `unique()` (numbers by value, strings by code point).

`Totals` of these ratios gives scikit-learn's numbers, bit for bit, for integer weights:

- `ClassMatches` gives the precision, recall and F1 of each class (`average=None`).
- `AllClassMatches` gives the micro average.
- `LabelsMatch` gives `accuracy_score` (for multilabel answers, the subset accuracy).

So a promptfoo run gives the micro precision, recall and F1, and the score of each class, in its column headers.

### For a whole run

A macro average or a weighted average is not a ratio of sums: it needs the score of each class first. `ClassCounts` keeps the counts of each class: the true positives (hits), the predicted (stated) and the true (expected). It adds the weight of each answer in the order of the answers, as numpy's `bincount` does. torchmetrics does the same with `update()` and `compute()`.

```ts
import {
  ClassCounts,
  LabelCase,
  LabelComparer,
  MacroAverage,
  WeightedAverage,
} from '@zukhruf/evals/classification';

const counts = ClassCounts.of({
  expected: ['a', 'b', 'b'],
  stated: ['a', 'a', 'b'],
});

counts.accuracy(); // accuracy_score
counts.fBeta({ beta: 1, average: new MacroAverage() }); // f1_score(average='macro')
counts.precision({ average: new WeightedAverage() }); // precision_score(average='weighted')
counts.confusionMatrix().rows(); // confusion_matrix, labels in sorted order

// The same counts, one answer at a time:
const run = new ClassCounts({ multilabel: false });
const testCase = new LabelCase({ expected: 'a', weight: 1 });
run.add(new LabelComparer().compare('a', testCase), testCase.weight);
```

- `ClassCounts.of({ expected, stated, weights })` builds multiclass counts from two arrays of labels. `weights` is optional, and an answer without a weight weighs 1.
- `ClassCounts.ofIndicators({ expected, stated, weights })` builds multilabel counts from two label indicator matrices. Each column is a class, also when no answer has it.
- `new ClassCounts({ multilabel })` starts empty, and `add(comparison, weight)` adds one answer. Multiclass counts refuse an answer with no label or more than one label on a side.
- `average` is a Strategy: `new MicroAverage()`, `new MacroAverage()`, `new WeightedAverage()` or `new BinaryAverage(positiveLabel)`. `Average.of(classes, score)` gives one number from the score of each class. The micro average adds the counts with numpy's pairwise sum. The macro average is numpy's `nanmean`. The weighted average is scikit-learn's `_nanaverage`: it drops each NaN score with its weight, and it gives the plain mean when the weights add up to 0. `BinaryAverage` throws when scikit-learn raises: for multilabel counts, for more than two classes, and for a positive label that is not one of two classes. The samples average is a `SampleAveraged` scorer, because it needs the value of each answer.
- `labels` selects the classes to score, in its order. By default it is every class, in sorted order.
- `zeroDivision` is the score of a class whose denominator is 0: 0 (the default, as scikit-learn's `"warn"` gives), 1 or `NaN`. A macro average and a weighted average skip a `NaN` score.
- `form` is the arithmetic of the F-measure (ADR 0003). `new CountsForm()` is scikit-learn's and the default. It also gives the bits of TREC's F0.5 for integer counts. `new PrecisionRecallForm()` is van Rijsbergen's and SOB's.
- `confusionMatrix()` throws for multilabel counts, as scikit-learn raises.

### Probabilities

`ProbabilityComparer` reads the stated probability of each class of an answer and gives a `ProbabilityComparison`. The answer is a `Map`, a plain object or the JSON text of an object. A key is a number label when the expected label is a number. A probability outside [0, 1] throws a `RangeError`. The case has one expected label.

`BrierScore` follows scikit-learn's `brier_score_loss`. For one answer, it adds the squares of (1 for the expected label, else 0, minus the probability) over the classes in sorted order, with numpy's pairwise sum. For two classes, it multiplies the sum by 0.5. `new BrierScore({ positiveLabel })` reads only the probability p of the positive label, and the two classes are 1 − p and p. `form` is the arithmetic of the score of p (ADR 0003). `new TwoColumnForm()` is scikit-learn's and the default: 0.5 × the sum of the squares of the two classes. `new SquaredErrorForm()` is (p − y)², as numpy gives `np.mean((p - y) ** 2)`. The two forms can differ in the last bit. A form needs `positiveLabel`. Its ratio is the score of one answer over 1. `brierScore.mean(comparisons, weights)` gives the score of a whole run with numpy's pairwise sum, bit for bit.

## Use it with promptfoo

`ScorerAssertion` is in `./promptfoo`. It takes the comparer and the case reader of a family. The sample below scores labels. [docs/structured.md](docs/structured.md) has a structured sample.

`PromptfooAssertion` adapts a scorer set to a per-row assertion. Each ratio becomes a named score with its whole as the weight, so the column header shows the same ratio of sums as `Totals`. It reads the case from the config of the assertion.

`ScorerAssertion` holds one scorer with its `weight` (how much it counts in the score of the test) and its `threshold` (when it passes). Both numbers are required. It reads the case from the vars of the test.

promptfoo stores the config of a run as JSON, and `--resume` and `--retry-errors` build the run from that stored config. A function does not survive JSON, so a config holds no scorer assertion. An `AssertionModule` holds the scorer assertions by name, in a module that promptfoo loads. Its `assert(...names)` gives JSON assertions whose `value` is the file reference `file://<module>:<name>`. promptfoo loads the function from the default export of the module when it grades, on the first run and on a resumed run (structured ADR 0013 in docs/adr/structured).

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

/** The hits, the stated and the expected of one input. */
export class Counts {
  constructor(counts: { hits: number; stated: number; expected: number });
  readonly hits: number;
  readonly stated: number;
  readonly expected: number;
}
/** The counts of one input that precision, recall and the F-measure read. */
export interface Matches<Input> {
  counts(input: Input): Counts;
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
  of(counts: Counts, beta: number): number;
}
export class CountsForm implements FMeasureForm {}
export class PrecisionRecallForm implements FMeasureForm {}

/** A factor in [0, 1] for one input; its ratio is Ratio(factor, 1) (Template Method). */
export abstract class Penalty<Input> implements Scorer<Input> {
  abstract factor(input: Input): number;
}
/** The penalty whose factor is 1 when it holds, else 0. */
export abstract class Gate<Input> extends Penalty<Input> {
  abstract holds(input: Input): boolean;
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
  constructor(scorer: Scorer<Input>, ...scorers: Scorer<Input>[]);
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
  readonly name: string;
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
/** Gives one ratio for each group of an input, such as each field or each class. */
export abstract class Grouped<Input> {
  constructor(scorer: Scorer<Input>);
  /** The groups of an input (Template Method). */
  protected abstract groups(input: Input): Iterable<[string, Input]>;
  /** The ratio of the scorer on each group, under `${group} ${label}`. A group whose whole is 0 gives no ratio. */
  ratios(input: Input, label: string): [string, Ratio][];
}
export class ScorerSet<
  Case extends Weighted,
  Input,
> implements ScorecardScorer<Case> {
  constructor(
    scorers: Readonly<Record<string, Scorer<Input> | Grouped<Input>>>,
    options: { comparer: Comparer<Case, Input> },
  );
}

/** Adds ratios: the sum of the parts divided by the sum of the wholes. */
export class RatioOfSums {
  /** The ratio of sums of a list of ratios, in one call. */
  static of(ratios: Iterable<Ratio>): RatioOfSums;
  add(ratio: Ratio): void;
  get ratio(): Ratio;
  get value(): number;
}
/** The ratio of sums of each name over many scorecards. */
export class Totals {
  add(scorecard: Scorecard, weight: number): void;
  get(name: string): RatioOfSums;
  names(): IterableIterator<string>;
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
/** The vars of the test that promptfoo gives a javascript assertion of a shared defaultTest. */
export type VarsContext = {
  readonly vars: Readonly<Record<string, unknown>>;
};
/** What an assertion module needs of an assertion. A ScorerAssertion is one. */
export type ModuleAssertion = {
  readonly metric?: string | undefined;
  readonly weight: number;
  readonly threshold: number;
  readonly value: (output: string, context: VarsContext) => number;
};
/** The module that promptfoo loads the function of each scorer assertion from (structured ADR 0013 in docs/adr/structured). */
export class AssertionModule<Name extends string> {
  constructor(url: string, assertions: Readonly<Record<Name, ModuleAssertion>>);
  /** The default export of the module: the value function of each name. */
  readonly functions: Readonly<Record<string, ModuleAssertion['value']>>;
  assert(...names: Name[]): FileAssertion[];
}

// @zukhruf/evals/classification

/** A label: a number or a string, as scikit-learn reads a label. */
export type Label = number | string;

/** The expected labels of one test, and its weight. */
export class LabelCase implements Weighted {
  constructor(options: { expected: Label | readonly Label[]; weight: number });
  readonly expected: ReadonlySet<Label>;
  readonly weight: number;
}
/** Reads `vars.expected` (a label or a list of labels) and `vars.weight` (1 when none). */
export class LabelVarsCase implements CaseReader<LabelCase> {}
/** Reads `config.expected`, with the weight 1. */
export class LabelConfigCase implements CaseReader<LabelCase> {}

export class LabelComparison {
  constructor(sides: {
    stated: ReadonlySet<Label>;
    expected: ReadonlySet<Label>;
  });
  readonly stated: ReadonlySet<Label>;
  readonly expected: ReadonlySet<Label>;
  /** The labels of both sides, in the order of numpy's unique(). */
  labels(): Label[];
  /** The comparison of one class. */
  only(label: Label): LabelComparison;
}
/** Reads the stated labels: a label, a list of labels, a JSON array of labels, a number, or one string label. */
export class LabelComparer implements Comparer<LabelCase, LabelComparison> {}

export class ClassMatches implements Matches<LabelComparison> {
  constructor(label: Label);
}
export class AllClassMatches implements Matches<LabelComparison> {}
/** Holds when the stated labels are the expected labels. */
export class LabelsMatch extends Gate<LabelComparison> {}
export class PerClass extends Grouped<LabelComparison> {
  constructor(
    scorer: Scorer<LabelComparison>,
    options?: { labels?: readonly Label[] },
  );
}

/** The classes that an average reads. */
export type Classes = {
  readonly selected: ReadonlyMap<Label, Counts>;
  readonly present: ReadonlyMap<Label, Counts>;
  readonly multilabel: boolean;
};
/** How the scores of the classes become one number (Strategy). */
export interface Average {
  of(classes: Classes, score: (counts: Counts) => number): number;
}
export class MicroAverage implements Average {}
export class MacroAverage implements Average {}
export class WeightedAverage implements Average {}
export class BinaryAverage implements Average {
  constructor(positiveLabel: Label);
}

type ScoreOptions = {
  average: Average;
  labels?: readonly Label[];
  /** 0 (the default), 1 or NaN. */
  zeroDivision?: number;
};
/** The counts of each class over many answers: true positives, predicted and true. */
export class ClassCounts {
  constructor(options: { multilabel: boolean });
  static of(answers: {
    expected: readonly Label[];
    stated: readonly Label[];
    weights?: readonly number[];
  }): ClassCounts;
  static ofIndicators(answers: {
    expected: readonly (readonly number[])[];
    stated: readonly (readonly number[])[];
    weights?: readonly number[];
  }): ClassCounts;
  add(comparison: LabelComparison, weight: number): void;
  labels(): Label[];
  accuracy(): number;
  precision(options: ScoreOptions): number;
  recall(options: ScoreOptions): number;
  fBeta(options: ScoreOptions & { beta: number; form?: FMeasureForm }): number;
  support(): ReadonlyMap<Label, number>;
  /** Throws for multilabel counts. */
  confusionMatrix(): ConfusionMatrix;
}
export class ConfusionMatrix {
  readonly labels: readonly Label[];
  count(expected: Label, stated: Label): number;
  rows(): number[][];
}

/** The stated probability of each class of one answer, and its expected label. */
export class ProbabilityComparison {
  readonly probabilities: ReadonlyMap<Label, number>;
  readonly expected: Label;
}
/** Reads the probability of each label from a Map, an object or its JSON text. */
export class ProbabilityComparer implements Comparer<
  LabelCase,
  ProbabilityComparison
> {}
/** The arithmetic of the Brier score of the probability p of the positive label (ADR 0003). */
export interface BrierForm {
  of(probability: number, expected: 0 | 1): number;
}
export class TwoColumnForm implements BrierForm {}
export class SquaredErrorForm implements BrierForm {}
export class BrierScore implements Scorer<ProbabilityComparison> {
  constructor(
    options?:
      | { positiveLabel?: undefined; form?: undefined }
      | { positiveLabel: Label; form?: BrierForm },
  );
  /** The score of a whole run, with numpy's pairwise sum. */
  mean(
    comparisons: readonly ProbabilityComparison[],
    weights?: readonly number[],
  ): number;
}
```

## Who uses each part

The consumers below come from the search of 2026-11-06 (eight evals in four repositories). Each consumer changes to follow the package in its own backlog item.

| Consumer                                     | Uses                                                                                               | Backlog                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| offers-evals (SOB and the offers eval)       | core, `./structured`, `./promptfoo`                                                                | offers-evals #3892            |
| context-compiler, startup-credits offers     | core, `./structured` (`ByBestMatch`), `./promptfoo`                                                | context-compiler #3893, #3882 |
| context-compiler, startup-credits page kinds | `./classification` (accuracy, the precision and recall of each class, the confusion matrix)        | #3882 slice 2                 |
| `@zukhruf/mteb`, classification tasks        | `./classification` (`ClassCounts`: accuracy, macro and weighted P, R and F1; label-indicator rows) | mutex #3890                   |
| relevance-filtering eval                     | `./classification` (`BinaryAverage`, F0.5 with `CountsForm`, `BrierScore` with `SquaredErrorForm`) | mutex #3891                   |
| event-detection eval                         | nothing yet: its MUC, B³, CEAF-e and BLANC wait for `./clustering`                                 | —                             |

The package was built in two items: mutex #3888 (the core, `./promptfoo` and the move of `./structured`) and mutex #3889 (the generic core, the F-measure form and `./classification`).

## Documentation

- [ADR 0001: one package, with a subpath for each shape of answer](docs/adr/0001-one-package-with-a-subpath-for-each-shape-of-answer.md)
- [ADR 0002: the core is generic over the answer](docs/adr/0002-the-core-is-generic-over-the-answer.md)
- [ADR 0003: classification follows scikit-learn, from the counts of each class](docs/adr/0003-classification-follows-scikit-learn-from-the-counts-of-each-class.md)
- [ADR 0004: two runs are compared by a paired bootstrap over their tests](docs/adr/0004-two-runs-are-compared-by-a-paired-bootstrap-over-their-tests.md) (design for review)
