# The promptfoo adapter gives the samples of a run, with the latest result of each answer

Status: accepted and built (2026-11-27, #6110): `src/promptfoo/promptfoo-samples.ts`. Ezz ruled the shape ("Adapter + Iterator"). The build adds three rules that the real rows asked for: the rows are of one prompt (a run of two providers is two logs), a row that is still a promptfoo error after the newest-row rule was never retried and refuses the run (ADR 0005 keeps such failures for `--retry-errors`), and a failed call is the graded row of `FailedCall` with its `failed` reason. The tests run the real promptfoo CLI, a retry with `--retry-errors` included. Two facts of the real rows shaped the code: promptfoo 0.126 gives each execution of a test, each repeat too, its own `testIdx`, in the order of the tests and then of their repeats, so `testIdx` alone is the key and the order of an answer (a key with the epoch added nothing that a mutation could show), and it writes the weight of every named score, 1 when its assertion sets none, so a score with no weight refuses the run instead of reading as weight 1. A row with no tokens and no cost has no usage, a new call too, since promptfoo fills the tokens with 0 when a provider measured none.

## Context

`./promptfoo` turns scorers into promptfoo assertions. Nothing reads a promptfoo run back. Three evals read the rows by hand (read 2026-11-27):

| Place                                                      | What it reads                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| offers-evals `apps/offers/src/climb.ts`, `Answers.from`    | `Ratio(namedScores[n] × namedScoreWeights[n], namedScoreWeights[n])` for each name of the goal        |
| offers-evals `apps/offers/src/held-out-compare.ts`, `rows` | the same, from an export file (offers-evals #4593, strike 2, ledger `docs/copied-from-climb-host.md`) |
| offers-evals `apps/sob/src/summary/scored-row.ts`, `rowOf` | `namedScores` as values, and the modality and difficulty of the metadata                              |

`latestResults`, which keeps one row for each test after `--retry-errors`, is copied from offers-evals' SOB summary into context-compiler (#3996). promptfoo hands the rows to an `afterAll` extension as `context.results`, and `promptfoo export eval <id>` writes the same `EvaluateResult` rows under `results.results`.

The paper first had a static `PromptfooLog.read(results, options)`. A static method on a class with no state is a namespace; the job is to adapt one interface (promptfoo's rows) to another (the samples of the core), which is the Adapter pattern, and the samples are a sequence, which is the Iterator pattern.

## Decision

1. **`new PromptfooSamples(results, readers)` is an iterable of `Sample`s**, and `new RunLog(info, samples)` takes any iterable of samples (core ADR 0007). The results are `EvaluateResult` rows, from `afterAll` or from an export.
2. **The caller gives the test id, the case reader and the answer reader** (Strategy). promptfoo has no stable test id (ADR 0004, point 1). The case comes from the vars through the `CaseReader` that the assertions already use. The answer reader turns the stored output into the value that the comparer reads.
3. **The ratio of a name is the named score times its weight, over its weight.** So `Totals` of the log gives the ratio of sums that promptfoo's column header shows (`PromptfooAssertion`).
4. **The newest result of each test and epoch wins.** After `--retry-errors`, a test has a stale error row and its retried row. The adapter keeps the one that promptfoo wrote last, as `latestResults` does.
5. **A failed call is a failed sample.** A result with an error and no output gives the answer null and its error (ADR 0005).
6. **The usage comes from `tokenUsage` and `cost`, and `response.cached` marks a replay.** `prompt` and `completion` are the input and output tokens, `completionDetails.cacheReadInputTokens` the input that the provider read from its prompt cache, and `cost` the cost of the answer. A row whose `response.cached` is true is a replayed sample (core ADR 0007, point 5), and its usage is the usage that the harness reports for the answer: promptfoo keeps a cached answer's tokens and counts what this run incurred apart, in `incurredTokenUsage` and `incurredCost`. A harness that reports a replay with no tokens and no cost gives it no usage: eval-ove of offers-evals has 711 such rows of 921 (offers-evals #6114).

## Consequences

- The three readers of offers-evals move onto it, and the copies go: #4593 (`climb.ts`, `held-out-compare.ts`), #6115 (`rowOf`).
- A reader of another runner, such as Inspect AI's logs, is one more iterable of samples; `RunLog` does not change.
- context-compiler's copy of `latestResults` stays: startup-credits is not changed.
