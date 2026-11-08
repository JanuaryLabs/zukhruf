# Evals

An eval sends inputs to a harness and scores each answer against its label. This context scores the answers. The answers have different shapes, so each shape has its own family, and all families share one core. The words of each family are under its heading.

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
The arithmetic that gives the value of an F-measure. Two forms give the same number in algebra and different numbers in the last bit: the counts form (scikit-learn) and the precision-recall form (van Rijsbergen, SOB). These two names are the names of this package.

**Penalty**:
A factor in [0, 1] for one input, as BLEU's brevity penalty is. The factor 1 is no penalty. A penalty is also a scorer: its ratio is the factor over 1.

**Gate**:
The penalty whose factor is 0 or 1. A gate says what it checks and why it fails.

**Penalized**:
A scorer whose part is multiplied by the factor of each of its penalties, for each answer. Its whole stays.

**Grouped scorer**:
A scorer that gives one ratio for each group of an input, such as each field (`PerField`) or each class (`PerClass`), under the label of the group and its own label.

**Scorer set**:
A scorecard scorer that holds labelled scorers and grouped scorers. Its comparer makes the input once. It passes when each of its gates holds.

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

**Run**:
The scorecards that one model gives on many tests of one harness, each with its test id and its weight. A paired bootstrap reads two runs (ADR 0004).

**Baseline run** and **change run**:
The two runs of a paired bootstrap: the run to compare against, and the run with the change, such as another model. mteb's `pairedBootstrapTest(baseline, change)` and Braintrust's "baseline experiment" use the same words.
_Avoid_: control and treatment, before and after

**Test id**:
The key that pairs a test of the baseline run with the same test of the change run. The caller gives it, because promptfoo has no stable id. Inspect AI calls it `Sample.id`, and Braintrust calls it the comparison key.
_Avoid_: row id (a case is not a row)

**Epoch**:
One answer of one run to one test. A run can have many epochs of a test, and it takes their mean, name by name. The word is Inspect AI's: promptfoo calls it a repeat, and Braintrust calls it a trial.
_Avoid_: repeat, trial

**Paired bootstrap**:
The bootstrap of two runs on the same tests: each resample draws the tests with replacement, and both runs read the same draw (Koehn 2004; Efron and Tibshirani 1993). `PairedBootstrap` gives a verdict for one name.

**Paired difference**:
For one name, the ratio of sums over the change run minus the ratio of sums over the baseline run, on the same tests (Koehn 2004). When each whole and each weight is 1, it is the mean of the differences of the tests.

**Verdict**:
The result of a paired bootstrap for one name: better, worse or inconclusive, with the paired difference, its difference interval, a p-value and the counts of the tests. The words better, worse and inconclusive are mteb's `ChangeVerdict.result`. The p-value has no correction: a caller that tests many names corrects it, such as with Holm.

**Improvements**, **regressions** and **ties**:
The tests whose value is better, worse or the same in the change run, by the direction of the name. Braintrust's `summarize()` gives improvements and regressions. "Ties" is the label of this package.

**Direction**:
If a higher value of a name is better: `higherIsBetter`, as lm-evaluation-harness gives each metric a `higher_is_better`. The caller gives it, because a scorecard holds names and not scorers. The Brier score is lower-is-better.

**Scorer assertion**:
A scorer with its weight, the threshold at which it passes, and the metric it reports under. It reads the case from the vars of the test. An assertion module gives it to promptfoo.

**Assertion module**:
The module that promptfoo loads the function of a scorer assertion from. A config names its scorer assertions, and gets JSON assertions with file references.

**Failed call**:
A model call that failed for its one test, also after its retries, such as a timeout or a 500. The harness gives the answer null for it, so its case keeps its expected values in the wholes (design for review, ADR 0005). HELM calls it a non-fatal error, and Inspect AI calls it an errored sample. `FailedCall` of `./promptfoo` is a coinage of this package.
_Avoid_: error row, failed sample

**Answer null**:
The answer of a failed call: the text `null`. Each family reads it as no answer: in `./structured` it is unparsed, and in `./classification` it is a stated label outside the class set.

**Failure of the run**:
A failure that each call would have, such as a 401. It is not a failed call. The provider throws it, so the result stays an error result, and `promptfoo retry` runs it again. HELM calls it a fatal error.

**Error result**:
A promptfoo result whose `failureReason` is `ResultFailureReason.ERROR`. promptfoo does not grade it, so its case adds nothing to the wholes. The word is promptfoo's.

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

**Class set**:
The classes of the task, in the order that the caller gives. scikit-learn calls it `labels`. The caller gives it, and the answers never add a class. A label outside the class set counts in no class. So a stated label outside it, such as the answer null, is a miss of the expected class (design for review, ADR 0006).

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

**Probability**:
The stated chance of one class in an answer: a number in [0, 1].

**Brier score**:
The mean squared difference between the stated probability of each class and its expected label, as scikit-learn's `brier_score_loss` gives it.

### Structured

**Record**:
One structured value, such as the offers of one web page.
_Avoid_: output, response (they are runner words)

**Expected record**:
The record that a person labelled for one test.
_Avoid_: ground truth, gold (two words for one thing)

**Stated record**:
The record that the harness gave for that test.
_Avoid_: prediction, actual

**JSON data**:
The value model of the package, `JsonData` of @zukhruf/python. An int and a float stay apart, and a dict keeps the order of its keys. A JavaScript value or JSON text becomes JSON data at the boundary, through `JsonValue`. A scorer set and a scorer assertion read a stated text as JSON text.

**Unparsed**:
A stated value that is not an object or an array, such as text that is not JSON. An unparsed value has no stated leaves. The answer null is unparsed, because JSON null is not an object or an array. SOB's `None` is the same.

**Path**:
The steps to one value: keys and item positions, such as `offers`, `1`, `value`, `amount`. A path is its steps, not a string. `$.offers[1].value.amount` is only how a path is written.

**Field**:
A path without its item positions, such as `$.offers[*].value.amount`. The package can count per field. A key of a comparison spec writes a field as a JSONPath query (RFC 9535) of name selectors and the wildcard selector.

**Leaf**:
A value at a path that is not an object or an array: a string, a number, a boolean or null.

**Comparison spec**:
The rules to compare two values of one kind: the alignment of each array, the comparator of all leaves, the comparator of each field, and the excluded fields.

**Draft**:
The version of JSON Schema that reads a schema: draft 7 or 2020-12. The `$schema` keyword names it, else it is 2020-12. `JsonSchema` can set it. The validator and the type walk read one schema with the same draft, so one schema has one meaning.

**Pattern**:
A regular expression in a JSON Schema: the value of `pattern`, or a name in `patternProperties`. The package reads it as ECMA-262 with the `u` flag, as JSON Schema says (2020-12 Core §6.4). SOB's evaluate.py reads it with Python's `re`, which gives other answers for some patterns. No SOB schema has a pattern (0 of 10,177, 2026-11-06), so no SOB number depends on it. See #3903.

**Excluded field**:
A field that the walk does not compare.

**Comparison**:
The result of the walk for one stated value and its case: the leaf pairs, the item pairs, and if the stated value is parsed.

**Leaf pair**:
One expected leaf and one stated leaf at the same field, or one leaf with no other side. Each side keeps its own path.

**Alignment**:
The rule that pairs the items of one array: by position or by best match.

**By position**:
The alignment that pairs item 0 with item 0, item 1 with item 1, and so on. It is the default, and SOB's rule.

**By best match**:
The alignment that pairs the items in any order. Of all pairings, it takes the one with the most agreeing leaves (the Hungarian algorithm).

**Ordered array**:
An array whose items pair by position.

**Set array**:
An array whose items pair by best match.

**Match**:
A rule that says if two items of a set array can be a pair, such as "the two quotes are the same sentence".

**Item**:
One element of an array on one side, with its path and its value. An item that has no pair is a stated item or an expected item without a pair.

**Pair**:
One stated item and one expected item that the walk compares leaf by leaf.

**Comparator**:
A rule that says if two leaves agree, such as JSON equality, Python equality, a number in a tolerance, normalized text, or a token overlap.

**JSON equality**:
Two values agree when JSON Schema calls them equal: `1` agrees with `1.0`, and `true` does not agree with `1`. It is the default comparator.

**Python equality**:
Two values agree as Python's `==` says: `true` agrees with `1` and with `1.0`. SOB's caller gives it.

**Presence**:
The expected record and the stated record both have a value at one path. The two values can be different. A path match counts presence.

**F1 of SOB**:
SOB's evaluate.py gives each F1 as 2·p·r/(p + r): the precision-recall form of the F-measure. SOB's caller gives that form to `F1` and `TokenF1`. The default form, the counts form, gives the part divided by the whole.

**Token F1**:
The F1 of the words that a stated value shares with its expected value, as SQuAD reads words. It gives partial credit to text.

**Type precision**:
The stated leaves whose type the JSON Schema allows at their path, by the rules of its draft, divided by the stated leaves. It reads the stated record as the harness gave it, also when the record is invalid.

**Shortfall penalty**:
The penalty `min(1, (value / target) ** power)` of the value of a scorer. It is 1 when the value reaches the target. SOB gives it to image and audio records, with the F1 of the paths, the target 0.90 and the power 2.

**Subset**:
A part of a dataset that the caller scores with its own scorers, such as the modality of SOB (text, image or audio). The caller gives each test the scorers of its subset. A case has no subset.
_Avoid_: modality (a word of SOB), split (train and test are splits)

**Schema compliance**:
The stated record is parsed and agrees with a valid JSON Schema. A scorer that is gated by schema compliance gives an invalid record the part 0 and keeps its whole.

**All matched**:
Every leaf pair of a comparison agrees, and every item has a pair. When it reads null as no value, as `nullIsMissing` says, a null leaf does not count on either side.
