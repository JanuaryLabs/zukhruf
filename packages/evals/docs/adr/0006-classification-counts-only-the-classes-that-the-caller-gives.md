# Classification counts only the classes that the caller gives

Status: Accepted 2026-11-08 by Ezz ("Approve both (Recommended)", backlog #3970). It amends decision 2 of ADR 0003. Ezz gave the rule for it: "design the package and force consumer to change not the other way around." The code is not built yet.

## Context

ADR 0003 says that `./classification` follows scikit-learn 1.9.1, from the counts of each class. scikit-learn's metrics take `labels`, the set of classes to count. With `labels=None`, the classes are the labels of both sides, in sorted order ("By default, all labels in `y_true` and `y_pred` are used in sorted order", `sklearn/metrics/_classification.py:2016-2022`). When the caller gives `labels`, a label outside it adds to no class:

- `multilabel_confusion_matrix` counts each label of the answers, then keeps only the counts of `labels` ("Retain only selected labels", `_classification.py:749-758`, `797-801`). So a stated label outside `labels` is a miss of the expected class: the true count of that class has the answer, and its true positives do not. The stated label is not a predicted count of any class.
- `confusion_matrix` removes each pair with a label outside `labels` ("eliminate items not in labels", `_classification.py:584-590`).
- `accuracy_score` has no `labels`. An answer whose stated label is not its expected label is wrong.

The package has `labels` today, but only as an option, and not in every part:

- `PerClass` takes an optional `labels` (`src/classification/per-class.ts:13-26`). Without it, the classes are the labels of both sides of each answer.
- `ClassCounts` takes an optional `labels` for each score (`src/classification/class-counts.ts:16-20`, `228-242`). Its `labels()`, `support()` and `confusionMatrix()` always use the labels of the answers.
- `AllClassMatches` and `BinaryAverage` take no `labels`. `AllClassMatches` counts each stated label (`all-class-matches.ts:9-15`). `BinaryAverage` reads the classes of the answers (`binary-average.ts:16-30`).

No consumer gives `labels` today (search of 2026-11-08, below). So the answers decide the classes. A failed call answers the label `"null"` (ADR 0005), and that label becomes a class:

- In startup-credits' page kinds, promptfoo shows the columns `null precision` and `null f1`, and the summary has the class `null` with support 0 (context-compiler 3260473, `apps/startup-credits/promptfoo/page-kinds.test.ts:275-276`, `326-328`). A failed page lowers the macro averages two times: once as a miss of its true kind, and once through the class `null`. scikit-learn 1.9.1 gives the macro recall 0.3 over five classes with `labels=None`, and 0.375 with `labels=['home', 'investor', 'list', 'program']` (a probe of 2026-11-08 on the labels and answers of that test).
- When the labels are numbers, the answer null stops the run. `LabelComparison.labels()` sorts the labels of both sides, and `compareLabels` refuses a number and a string (`label.ts:16-24`). A probe of 2026-11-08 on `src/classification` gave "The labels 1 and "null" mix a number and a string" for `labels()` and for `ClassCounts.add`. scikit-learn also refuses this mix ("Mix of label input types").

The answer null is one case of a general fault. A harness can state any text: a failed call, a label with a typo, a kind that the task does not have. With the classes taken from the answers, each such answer adds a class, and the denominators of the macro averages change with the faults of the harness.

## Decision

1. **The class set is required.** The class set is the classes of the task. scikit-learn calls it `labels`, and the package keeps that name. A part that counts classes takes the class set from the caller, and it never takes a class from the answers. So no answer can add a class. This is "make illegal states unrepresentable": a class that the caller did not give cannot exist.
2. **A label outside the class set counts in no class**, on each side, as scikit-learn's `labels` gives it. A stated label outside the class set is a miss of the expected class, and it is not a predicted count of any class. The accuracy still reads it: the answer is wrong. The confusion matrix has no pair with it.
3. **The answer null of a failed call is a stated label outside the class set.** It is a miss of its expected class, it is not a false positive of any class, and it is a wrong answer. The micro precision does not count it, and the micro recall does (scikit-learn 1.9.1 gives the micro precision 0.4 and the micro recall 0.3333333333333333 on the page-kinds test above). A class set that holds the label `"null"` reads the answer null as that class. No consumer has such a class set (2026-11-08).
4. **One home of the class set for each route.** For each answer, the comparer holds it. For a whole run, the counts hold it. The proposal:

   ```ts
   // Proposal: no code exists yet.
   new LabelComparer({ labels }); // its comparisons hold the class set
   comparison.labels(); // the class set, in the order that the caller gives
   comparison.only(label); // the comparison of one class: its class set is [label]
   new AllClassMatches(); // counts only the labels of the class set of the comparison
   new PerClass(scorer); // a group for each class of the class set; no labels option
   new ClassCounts({ labels, multilabel });
   ClassCounts.of({ labels, expected, stated, weights });
   ClassCounts.ofIndicators({ expected, stated, weights }); // each column is a class, as today
   counts.precision({ average, zeroDivision }); // no labels option: the counts have one class set
   counts.labels(); // the class set, in the order that the caller gives
   counts.support(); // the true count of each class of the class set
   counts.confusionMatrix(); // the classes of the class set, in their order
   ```

   - `ClassMatches(label)` and `LabelsMatch` do not change. `ClassMatches` counts one class. `LabelsMatch` is `accuracy_score`, which has no `labels`.
   - `Grouped` still drops a group whose whole is 0. So `PerClass` gives no column for a class that no answer states and no case expects.
   - The per-score `labels` option of `ClassCounts` goes. scikit-learn's `labels` is one set that selects the classes and gives their order. The counts take that set once.
   - The `Classes` of an average hold one map, the counts of the class set. `present` goes.
   - `BinaryAverage(positiveLabel)` reads the class set. It throws for multilabel counts, for a class set of more than two classes, and for a positive label outside the class set. A stated label outside the class set is a miss, as in each other average. scikit-learn raises for that answer ("Target is multiclass but average='binary'", `_classification.py:1911-1927`). Its documented form for one class gives the same number: "set `labels=[pos_label]` and `average != 'binary'`" (`_classification.py:2030-2031`).

5. **The numbers of scikit-learn stay, bit for bit.** A caller that ports a scikit-learn call with `labels=None` gives the class set that scikit-learn takes: the sorted labels of both sides (`unique_labels`). The golden fixtures already hold it (`fixtures/sklearn/generate.py:98`).

## Considered Options

- **`labels` stays optional, as in scikit-learn.** A caller that forgets it gets a class from each stray answer, and no check tells it. One option makes two meanings of "class". scikit-learn makes `labels` optional because its arrays come from a classifier, whose answers are its classes. An eval scores a harness that can state any text.
- **The consumer gives `labels` where it needs it.** The package would keep the fault, and each new consumer would find it again. Ezz's rule refuses this.
- **The comparer drops the stated labels outside the class set.** The comparison would lose what the answer stated, and `LabelsMatch` would explain a wrong answer with an empty set.
- **The class set on `PerClass` and on `AllClassMatches`.** A promptfoo eval would give the class set once for each column. Each copy could differ.
- **A required class set on the comparer and on the counts.** This option was selected.

## Consequences

The search of 2026-11-08 found 7 places outside the package that import `@zukhruf/evals/classification` (`grep -rln -e "evals/classification" -e "zukhruf/evals'"` over the TypeScript of `~/Desktop/experiments/*`, without `node_modules`, `dist` and `.git`: 14 files. Seven of them are the package itself or import only the core). Each one changes as below.

| Consumer                                                                         | Change                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| context-compiler `apps/startup-credits/promptfoo/assertions/page-kinds.ts:17-28` | `new LabelComparer({ labels: pageKinds })`, with `pageKinds` of `src/rules/page-kinds.ts:13-21`. The comment about `labels=None` goes. The test `page-kinds.test.ts:265-280` loses the columns `null precision` and `null f1`.                                                                                              |
| context-compiler `apps/startup-credits/promptfoo/summary/page-kinds.ts:23, 31`   | `new LabelComparer({ labels: pageKinds })` and `new ClassCounts({ labels: pageKinds, multilabel: false })`. The comment about `labels=None` goes. The test `page-kinds.test.ts:309-338` gets scikit-learn's numbers with `labels=pageKinds`: no class `null`, and seven classes in the support and in the confusion matrix. |
| mutex `packages/information-filtering/relevance-filtering/eval/metrics.ts:44-47` | `ClassCounts.of({ labels: [NOT_RELEVANT, RELEVANT], expected, stated })`. The numbers do not change.                                                                                                                                                                                                                        |
| mutex `packages/mteb/src/abstasks/classification.ts:293`                         | `ClassCounts.of({ labels, expected: yTest, stated: yPred })`, with `labels` the sorted labels of `yTest` and `yPred`, as scikit-learn's `unique_labels` gives them for MTEB's `labels=None`. The numbers do not change.                                                                                                     |
| mutex `packages/mteb/src/abstasks/multilabel-classification.ts:205`              | No change: `ofIndicators` takes its classes from the columns.                                                                                                                                                                                                                                                               |
| mutex `packages/mteb/src/dependencies/sklearn-neighbors.ts:178`                  | No change: `ofIndicators`.                                                                                                                                                                                                                                                                                                  |
| mutex `packages/mteb/src/dependencies/multilabel.golden.test.ts:130`             | No change: `ofIndicators`.                                                                                                                                                                                                                                                                                                  |

- In page kinds, three kinds of `pageKinds` (`article`, `other_program`, `other`) have no page and no answer in that test. Each one scores `zeroDivision` in the macro averages, as scikit-learn gives it (ADR 0003, decision 4). With `zero_division=0`, scikit-learn 1.9.1 gives the macro recall 0.21428571428571427. With `zero_division=NaN`, it gives 0.375. The choice of `zeroDivision` is the consumer's, and it does not change in this ADR.
- The package changes its own tests and README: `per-class.test.ts`, `class-counts.test.ts`, `label-comparer.test.ts` and `sklearn.golden.test.ts` give the class set. The golden tests read it from the fixtures. A score of one class (`average=None`) uses counts with the class set `[label]`, as scikit-learn's `labels=[pos_label]`.
- offers-evals imports only the core and `./structured` and `./promptfoo`. It does not change.
- The build uses the coding:remove-code skill for the options that go: the `labels` option of `PerClass`, the per-score `labels` of `ClassCounts`, and `present` of `Classes`.
