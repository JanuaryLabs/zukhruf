# Classification follows scikit-learn, from the counts of each class

Status: Proposed, for review (design on paper, 2026-11-06). It proposes an amendment to ADR 0011 of `@zukhruf/structured-eval`; see "The form of the F-measure".

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

Three forms of the F-measure give the same number in algebra and different numbers in the last bit:

| Form (names of this package) | Arithmetic                               | Who uses it                                                                            |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `CountsForm`                 | (1 + β²)·tp / (β²·true + predicted)      | scikit-learn; mteb; the micro value of a ratio of sums                                 |
| `ErrorsForm`                 | (1 + β²)·tp / ((1 + β²)·tp + β²·fn + fp) | torchmetrics; relevance-filtering's T11F (β = 0.5)                                     |
| `PrecisionRecallForm`        | (1 + β²)·P·R / (β²·P + R)                | van Rijsbergen (1979); event-detection; SOB's `evaluate.py` (2·p·r/(p + r) when β = 1) |

The form is a Strategy, as the quantile method of `@zukhruf/statistics` is. `CountsForm` is the default, because it is the form of scikit-learn. With it, the value of an F-measure ratio is its part divided by its whole, as for every other ratio.

This is an amendment to ADR 0011 of `@zukhruf/structured-eval`, which Ezz accepted on 2026-11-06. There, `F1Ratio` always gives the value of `evaluate.py` (2·p·r/(p + r)), and that value is "the one exception to the rule of a ratio". With the amendment, SOB's caller gives `PrecisionRecallForm`, as it gives `PythonEquality` and `ByPosition` (ADR 0011, decision 8: "SOB is a configuration in its caller"). The pooled micro value already uses the counts form, because `Totals` divides the sum of the parts by the sum of the wholes. Only the value of one answer changes with the form. So with SOB's form the exception stays, but it moves from the core into SOB's configuration. #3884 builds `F1Ratio` as ADR 0011 says. If Ezz accepts this amendment, the arithmetic moves out of `F1Ratio` into the Strategy, in #3889.

### Brier score

`BrierScore` follows `brier_score_loss`: for a binary answer, the mean of the squares of (expected − probability) over the two columns, times 0.5. relevance-filtering's evaluate.py takes the mean of (probability − expected)² with numpy's pairwise sum. The two can differ in the last bit. A golden test of #3891 shows if they do. If they do, the form of the Brier score becomes a Strategy too. If they do not, one form stays.

## Considered Options

- **The numbers of each place, each with its own code.** The three places stay copies, and the next eval adds a fourth.
- **The batch functions of scikit-learn only.** mteb fits, but a promptfoo eval scores one answer in each test. It could not give a micro average in the column headers.
- **The counts of each class as the state, with scikit-learn's numbers.** This option was selected.

## Consequences

- startup-credits' page kinds get the full confusion matrix and the precision and recall of each class in place of the list of wrong pairs (#3882, slice 2).
- relevance-filtering's T11F keeps its bits with `ErrorsForm` (#3891).
- mteb keeps its numbers. Its `hammingScore` and its LRAP stay in mteb until a second place needs them (#3890).
