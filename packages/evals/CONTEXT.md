# Evals

> **Status: design for review.** This glossary goes with the API on paper in [README.md](README.md).

An eval sends inputs to a harness and scores each answer against its label. This context scores the answers. The answers have different shapes, so each shape has its own family, and all families share one core. The words of the structured family stay in [the glossary of structured-eval](../structured-eval/CONTEXT.md) until that package moves in (backlog #3888).

## Language

### The core

**Answer**:
What the harness gave for one test, such as a record, a label or a ranked list.
_Avoid_: output, response, prediction (runner words)

**Shape of an answer**:
The kind of value that an answer is: a structured value, a set of labels, a ranked list or a partition. Each shape has one family.

**Family**:
The scorers of one shape of answer and their rules, under one import path, such as `./classification`. A family imports only the core.
_Avoid_: module, plugin

**Reference implementation**:
The program whose numbers a family must give, bit for bit, such as scikit-learn's `sklearn.metrics` for classification. A family is named by the shape of its answers, never by its reference implementation.
_Avoid_: oracle (a test word), golden (a test name)

**Case**:
What one test gives a scorer besides the answer: the expected value and its weight. A family can add to it, such as the JSON Schema of a structured case.
_Avoid_: test row, sample (runner words)

**Weight**:
How much one case counts in a weighted average. A case weighs what its test gives, else 1.

**Case reader**:
A rule that reads a case from the plain object that a runner holds for one test, such as the vars of a test or the config of an assertion.

**Comparer**:
The rule of a family that compares an answer with its case and gives the input of the scorers: `TreeWalk` in `./structured`, `LabelComparer` in `./classification`. A comparer works once for each answer, and each scorer reads its result.
_Avoid_: comparator (that is the rule for two leaves in `./structured`)

**Scorer**:
An object that gives one ratio for one input, such as `new Recall(new ClassMatches('program'))`. A scorer is named by what it measures. It keeps no result.
_Avoid_: metric (a metric adds the values of many answers)

**Ratio**:
A part and a whole, such as 2 right labels of 3 expected labels. Its value is the part divided by the whole, and 0 when the whole is 0.

**Matches**:
The counts of one input that precision, recall and the F-measure read: the hits, the stated and the expected. Each family gives its own matches.

**F-measure**:
The weighted harmonic mean of precision and recall, with a weight β: F1 when β is 1, F0.5 when precision counts more. Its part is (1 + β²) × hits, and its whole is β² × expected + stated.

**F-measure form**:
The arithmetic that gives the value of an F-measure. Three forms give the same number in algebra and different numbers in the last bit: the counts form (scikit-learn), the errors form (torchmetrics, TREC) and the precision-recall form (van Rijsbergen, SOB). These three names are the names of this package.

**Penalty**:
A factor in [0, 1] for one input, as BLEU's brevity penalty is. The factor 1 is no penalty. A penalty is also a scorer: its ratio is the factor over 1.

**Gate**:
The penalty whose factor is 0 or 1. A gate says what it checks and why it fails.

**Penalized**:
A scorer whose part is multiplied by the factor of each of its penalties, for each answer. Its whole stays.

**Scorer set**:
A scorecard scorer that holds labelled scorers. Its comparer makes the input once. It passes when each of its gates holds.

**Scorecard scorer**:
An object that scores one answer against its case and gives a scorecard. It keeps no result.

**Scorecard**:
The result of a scorecard scorer for one answer: passed, reason, checks and named ratios.

**Metric**:
A value over many answers, such as a mean of `Totals`, an interval of `Bootstrap` or a macro average of `ClassCounts`.

**Ratio of sums**:
The sum of the parts of many ratios divided by the sum of their wholes.

**Totals**:
The ratio of sums of each name over many scorecards.

**Micro average**:
A ratio of the counts of all answers added together, such as all hits divided by all expected labels. `Totals` gives it for a plain scorer.

**Samples average**:
The mean of the values of the answers, as scikit-learn's `average='samples'` takes it. `Totals` gives it for a `SampleAveraged` scorer.
_Avoid_: macro average (that is the mean over the classes)

**Bootstrap interval**:
The interval of a mean: many resamples draw the scorecards again, with replacement, and two quantiles of their means are its ends.

**Scorer assertion**:
A scorer with its weight, the threshold at which it passes, and the metric it reports under. It reads the case from the vars of the test. An assertion module gives it to promptfoo.

**Assertion module**:
The module that promptfoo loads the function of a scorer assertion from. A config names its scorer assertions, and gets JSON assertions with file references.

### Classification

**Label**:
The class that an answer states or that a case expects: an int or a string, as scikit-learn reads a label.
_Avoid_: category, tag, target

**Stated labels** and **expected labels**:
The labels of an answer and the labels of its case. One label is a set of one label.

**Multiclass**:
Each answer and each case has one label of many classes.

**Multilabel**:
Each answer and each case has a set of zero or more labels.

**Class**:
One label that the counts follow, such as `program` of the page kinds.

**Positive label**:
The class whose scores a binary average gives.

**Counts of a class**:
For one class over many answers: the true positives (both sides have it), the predicted (the answers have it) and the true (the cases have it). scikit-learn's `multilabel_confusion_matrix` gives the same counts.

**Support**:
The true count of a class: the cases that have it.

**Macro average**:
The mean of the scores of the classes.

**Weighted average**:
The mean of the scores of the classes, weighted by their support.

**Binary average**:
The score of the positive label only.

**Confusion matrix**:
The count of each pair of an expected label and a stated label, with the labels in sorted order.

**Accuracy**:
The answers whose stated labels are their expected labels, divided by the answers. For multilabel answers, scikit-learn calls it the subset accuracy.

**Brier score**:
The mean squared difference between the stated probability of each class and its expected label, as scikit-learn's `brier_score_loss` gives it.
