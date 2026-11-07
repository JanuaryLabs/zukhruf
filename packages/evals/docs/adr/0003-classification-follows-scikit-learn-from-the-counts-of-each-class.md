# Classification follows scikit-learn, from the counts of each class

Status: Accepted 2026-11-07 by Ezz ("accept and use remove code skill"), with its amendment to ADR 0011 of `@zukhruf/structured-eval` (see "The form of the F-measure"). It is built in backlog #3889.

## Context

Three places compare stated labels with expected labels:

| Place                                      | What it gives                                                                            | Its reference implementation                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| mteb `src/dependencies/sklearn.ts:445-640` | accuracy; macro and weighted precision, recall and F1; label-indicator rows (multilabel) | scikit-learn 1.9.1, numpy 2.5.4, bit for bit |
| relevance-filtering `eval/metrics.ts`      | binary precision, recall, F0.5 (T11F of TREC-11 Filtering), Brier score, Brier skill     | round-2 `evaluate.py` of its research        |
| startup-credits `eval/kind-score.ts`       | right and wrong answers, and the count of each wrong pair of labels                      | none                                         |

The three places have the same knowledge: the counts of each class. The rule of three (workspace ADR 0001, rule 2) moves it into one home. A promptfoo eval scores one answer in each test, and mteb scores a whole run at once. One home must serve both.

## Decision

1. The reference implementation is scikit-learn 1.9.1: `accuracy_score`, `precision_recall_fscore_support`, `fbeta_score`, `confusion_matrix`, `multilabel_confusion_matrix` and `brier_score_loss`. Golden tests require its numbers to the last bit. mteb's golden cases move in, and new cases cover the micro and binary averages, `labels` and `zero_division`.
2. The state is the counts of each class: true positives, predicted and true. torchmetrics does the same (`update()` adds the counts, `compute()` reads them). For each answer, `ClassMatches` and `AllClassMatches` give these counts as ratios, so `Totals` and promptfoo give the micro average and the score of each class. For a whole run, `ClassCounts` adds the comparisons and gives the macro, weighted and binary averages. Both read the same counts, so the two routes give the same micro numbers.
3. The average is a Strategy: `MicroAverage`, `MacroAverage`, `WeightedAverage` and `BinaryAverage(positiveLabel)`, as scikit-learn's `average`. The samples average is `SampleAveraged` of the core, because it needs the value of each answer.
4. A score whose denominator is 0 is 0, as scikit-learn's `zero_division="warn"` gives. `zeroDivision` can set 1 or `NaN`.

### The form of the F-measure

Two forms of the F-measure give the same number in algebra and different numbers in the last bit:

| Form (names of this package) | Arithmetic                          | Who uses it                                                                                                |
| ---------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `CountsForm`                 | (1 + β²)·tp / (β²·true + predicted) | scikit-learn 1.9.1 `fbeta_score`; mteb; relevance-filtering's T11F (β = 0.5); the value of a ratio of sums |
| `PrecisionRecallForm`        | (1 + β²)·P·R / (β²·P + R)           | van Rijsbergen (1979); event-detection; SOB's `evaluate.py` (2·p·r/(p + r) when β = 1)                     |

A third form, (1 + β²)·tp / ((1 + β²)·tp + β²·fn + fp), is the arithmetic of torchmetrics and of relevance-filtering's T11F. A probe on 2026-11-07 compared it with the counts form on 223,260 integer counts (tp 1-60, fn 0-60, fp 0-60). The two gave the same bits in every case for β = 1, 0.5 and 2, because β² is a binary fraction there and each sum is exact. They differed in 56,916 cases for β = 0.3, and in 24,528 cases when the hits are fractional (a penalized part). The counts form and the precision-recall form differed in 85,265 to 118,798 cases. So no caller needs the third form: T11F has integer counts and β = 0.5, and the counts form gives its bits.

The form is a Strategy, as the quantile method of `@zukhruf/statistics` is. `CountsForm` is the default, because it is the form of scikit-learn. With it, the value of an F-measure ratio is its part divided by its whole, as for every other ratio.

This is an amendment to ADR 0011 of `@zukhruf/structured-eval`, which Ezz accepted on 2026-11-06. There, `F1Ratio` always gives the value of `evaluate.py` (2·p·r/(p + r)), and that value is "the one exception to the rule of a ratio". With the amendment, SOB's caller gives `PrecisionRecallForm`, as it gives `PythonEquality` and `ByPosition` (ADR 0011, decision 8: "SOB is a configuration in its caller"). The pooled micro value already uses the counts form, because `Totals` divides the sum of the parts by the sum of the wholes. Only the value of one answer changes with the form. So with SOB's form the exception stays, but it moves from the core into SOB's configuration. #3884 builds `F1Ratio` as ADR 0011 says. Ezz accepted the amendment on 2026-11-07. The arithmetic moves out of `F1Ratio` into the Strategy in #3889, through the coding:remove-code skill.

### Brier score

`BrierScore` follows `brier_score_loss`: for a binary answer, the mean of the squares of (expected − probability) over the two columns, times 0.5. relevance-filtering's evaluate.py takes the mean of (probability − expected)² with numpy's pairwise sum. The two can differ in the last bit. A golden test of #3891 shows if they do. If they do, the form of the Brier score becomes a Strategy too. If they do not, one form stays.

The golden test of #3891 shows that they differ. For a negative answer with p = 0.1, scikit-learn's form gives 0.009999999999999998 and evaluate.py gives 0.010000000000000002, because 1 − (1 − p) is not p. So the form of the Brier score of a positive label is a Strategy, `BrierForm`, as `FMeasureForm` is for the F-measure. `TwoColumnForm` is scikit-learn's form and the default. `SquaredErrorForm` is (p − y)², the form of evaluate.py. A form needs a positive label: `BrierScore` refuses a form without one in its type.

## Considered Options

- **The numbers of each place, each with its own code.** The three places stay copies, and the next eval adds a fourth.
- **The batch functions of scikit-learn only.** mteb fits, but a promptfoo eval scores one answer in each test. It could not give a micro average in the column headers.
- **The counts of each class as the state, with scikit-learn's numbers.** This option was selected.

## Consequences

- startup-credits' page kinds get the full confusion matrix and the precision and recall of each class in place of the list of wrong pairs (#3882, slice 2).
- relevance-filtering's T11F keeps its bits with `CountsForm` (#3891), because its counts are integers and β is 0.5. Its Brier score gets the bits of evaluate.py with `SquaredErrorForm` (#3891).
- mteb keeps its numbers. Its `hammingScore` and its LRAP stay in mteb until a second place needs them (#3890).
