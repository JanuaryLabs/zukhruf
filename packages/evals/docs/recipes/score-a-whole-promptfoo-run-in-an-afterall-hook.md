# Recipe: Score a whole promptfoo run in an afterAll hook

**Use case.** promptfoo shows the mean of each named score over the tests. A micro average is a ratio of sums, so a column of promptfoo can show it. A macro average, a weighted average and a confusion matrix are not ratios of sums: they need the counts of each class over the whole run first ([For a whole run](../../README.md#for-a-whole-run)). No column of promptfoo shows them. promptfoo's `afterAll` extension hook gets all the results of the run once, after the last test. `ClassCounts` adds them up there.

**What you need.** `ClassCounts`, `LabelComparer` and `LabelCase` of `@zukhruf/evals/classification`, and promptfoo. The program needs only Node and promptfoo 0.125.1, which the workspace installs. It needs no model and no server: it builds the `AfterAllExtensionHookContext` itself and calls the hook.

## The steps

1. Write an `afterAll(context: AfterAllExtensionHookContext)` function, and export it.
2. Keep the latest result of each test from `context.results`. After a retry, the results hold each error result beside the result of its retry.
3. When an error result stays, write no scores, and tell the reader to run `promptfoo retry <evalId>`.
4. Give the class set to a `LabelComparer` and to a `ClassCounts`. Add the comparison of each result with its weight.
5. Read the accuracy, the averages, the support and the confusion matrix from the counts.
6. Name the hook in the `extensions` of the promptfoo config: `` `file://${join(import.meta.dirname, 'summary.ts')}:afterAll` ``.

## The program

The class set is three kinds of page. The program calls the hook two times. In the first run, test 2 timed out, then `promptfoo retry` answered it, so the results hold 6 results for 5 tests. The second run is the same run before the retry.

```ts title="score-run.ts"
import {
  type AfterAllExtensionHookContext,
  type EvaluateResult,
  ResultFailureReason,
} from 'promptfoo';

import {
  ClassCounts,
  LabelCase,
  LabelComparer,
  MacroAverage,
  WeightedAverage,
} from '@zukhruf/evals/classification';

// The class set, in the order of the confusion matrix.
const labels = ['program', 'home', 'list'];

// The latest result of each test. After a retry, promptfoo gives afterAll
// each error result beside the result of its retry. A retry runs only a test
// that has no result that is not an error, so that result is the latest.
function latestResults(results: readonly EvaluateResult[]): EvaluateResult[] {
  const runs = Map.groupBy(
    results,
    (result) =>
      `${result.testIdx}:${result.promptIdx}:${result.repeatIndex ?? 0}`,
  );
  return [...runs.values()].map(
    (rows) =>
      rows.find((row) => row.failureReason !== ResultFailureReason.ERROR) ??
      rows[0]!,
  );
}

// The hook: promptfoo calls it once, after the last test of the run.
export async function afterAll(
  context: AfterAllExtensionHookContext,
): Promise<void> {
  const rows = latestResults(context.results);
  const errors = rows.filter(
    (row) => row.failureReason === ResultFailureReason.ERROR,
  );
  console.log(
    `${context.evalId}: ${context.results.length} results, ${rows.length} tests`,
  );
  if (errors.length > 0) {
    console.log(
      `No summary: ${errors.length} of ${rows.length} tests are errors. Run promptfoo retry ${context.evalId}.`,
    );
    return;
  }
  const comparer = new LabelComparer({ labels });
  const counts = new ClassCounts({ labels, multilabel: false });
  for (const row of rows) {
    const testCase = new LabelCase({
      expected: String(row.testCase.metadata?.kind),
      weight: 1,
    });
    counts.add(
      comparer.compare(row.response?.output, testCase),
      testCase.weight,
    );
  }
  const macro = new MacroAverage();
  const weighted = new WeightedAverage();
  console.log({
    accuracy: counts.accuracy(),
    f1: {
      macro: counts.fBeta({ beta: 1, average: macro }),
      weighted: counts.fBeta({ beta: 1, average: weighted }),
    },
    support: Object.fromEntries(counts.support()),
    confusionMatrix: counts.confusionMatrix().rows(),
  });
}

// One result of the run: the test, its expected kind, and what the model gave.
function result(
  testIdx: number,
  kind: string,
  answer: { output: string } | { error: string },
): EvaluateResult {
  const failed = 'error' in answer;
  return {
    testIdx,
    promptIdx: 0,
    promptId: 'kind-of-page',
    testCase: { vars: { page: `page ${testIdx}` }, metadata: { kind } },
    vars: { page: `page ${testIdx}` },
    provider: { id: 'openai:chat:gpt-6.1-sol' },
    prompt: { raw: 'What kind of page is {{page}}?', label: 'kind-of-page' },
    response: failed ? { error: answer.error } : { output: answer.output },
    error: failed ? answer.error : null,
    failureReason: failed
      ? ResultFailureReason.ERROR
      : ResultFailureReason.NONE,
    success: !failed,
    score: failed ? 0 : 1,
    latencyMs: 0,
    namedScores: {},
  };
}

function context(
  evalId: string,
  results: EvaluateResult[],
): AfterAllExtensionHookContext {
  return {
    evalId,
    results,
    suite: { prompts: [], providers: [] },
    prompts: [],
    config: {},
  };
}

// A run in which test 2 timed out, then promptfoo retry answered it.
await afterAll(
  context('eval-retried', [
    result(0, 'program', { output: 'program' }),
    result(1, 'home', { output: 'home' }),
    result(2, 'list', { error: 'Request timed out' }),
    result(3, 'program', { output: 'list' }),
    result(4, 'list', { output: 'list' }),
    result(2, 'list', { output: 'list' }),
  ]),
);

// The same run before the retry: test 2 has only its error result.
await afterAll(
  context('eval-first-run', [
    result(0, 'program', { output: 'program' }),
    result(1, 'home', { output: 'home' }),
    result(2, 'list', { error: 'Request timed out' }),
    result(3, 'program', { output: 'list' }),
    result(4, 'list', { output: 'list' }),
  ]),
);
```

Output:

```
eval-retried: 6 results, 5 tests
{
  accuracy: 0.8,
  f1: { macro: 0.8222222222222223, weighted: 0.7866666666666666 },
  support: { program: 2, home: 1, list: 2 },
  confusionMatrix: [ [ 1, 0, 1 ], [ 0, 1, 0 ], [ 0, 0, 2 ] ]
}
eval-first-run: 5 results, 5 tests
No summary: 1 of 5 tests are errors. Run promptfoo retry eval-first-run.
```

## What the output shows

- **The retried run has 6 results and 5 tests.** `latestResults` dropped the error result of test 2, because the result of its retry is not an error.
- **The counts are scikit-learn's.** Test 3 expects `program` and states `list`. So `program` has the recall 0.5 and the F1 0.667, and `list` has the precision 0.667 and the F1 0.8. `home` has the F1 1. The macro F1 is the mean of the three F1 scores: 0.822. The weighted F1 weights each F1 by its support (2, 1 and 2): 0.787.
- **A row of the confusion matrix is the expected class, and a column is the stated class**, in the order of the class set. The row of `program` is `[1, 0, 1]`: one answer `program`, and one answer `list`.
- **Before the retry, the hook writes no scores.** promptfoo does not grade an error result, so its case adds nothing to the counts, and the scores would leave test 2 out.

## Things to know

- **promptfoo gives `afterAll` the stale error results after a retry.** promptfoo 0.125.1 deletes them only after the hook returns: the comment of the copy below names the lines of promptfoo's `dist`. A retry runs only a test that has no result that is not an error, so that result is the latest. The startup-credits app of context-compiler has a stricter copy of `latestResults`, in `apps/startup-credits/promptfoo/summary/latest-results.ts`: it also throws when two error results of one test have different scores. Backlog #3996 records that copy.
- **Give the class set.** An answer outside the class set, such as the answer null of a failed call, adds no class. It is a miss of its expected class ([ADR 0006](../adr/0006-classification-counts-only-the-classes-that-the-caller-gives.md)).
- **A failed call is not an error result.** When the provider returns `FailedCall`, promptfoo grades the answer null, and the hook counts it as a miss ([A failed call](../../README.md#a-failed-call), [ADR 0005](../adr/0005-a-failed-call-is-the-answer-null.md)).
- **Keep one `ClassCounts` for each prompt.** A run with many prompts or providers has a `promptIdx` on each result. Filter the results by `promptIdx`, and score each prompt alone.
- **The hook reads the expected kind from the metadata of the test.** The program sets `metadata.kind` on each test case. A real config gives it from its tests file.
