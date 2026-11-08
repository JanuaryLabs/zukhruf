# A failed call is the answer null

Status: Proposed (2026-11-08, backlog #3970). Ezz approved the design on 2026-11-08 ("Approve (Recommended)") and its retry rule ("Final null (Recommended)"). No code exists yet. The meaning of the answer null in `./classification` is in ADR 0006.

## Context

A harness calls a model for each test. Sometimes the call fails for its one test, also after its retries: a timeout, a 500, an answer that the model refused. promptfoo 0.125.1 does not grade a result whose provider gives `error` or no output. It sets `failureReason` to `ResultFailureReason.ERROR` and returns before it grades (`node_modules/promptfoo/dist/src/evaluator-BxCmvGtv.js:7940-7952`). This document calls such a result an error result. An error result has no named scores, so its case adds nothing to the wholes. The expected values of that case leave each ratio of sums, and the recall goes up.

Three places in two repositories give the same fix:

| Place                                                                                   | How it fixes the failed call                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| offers-evals `src/evals/sob/failed-answer.ts:15-29` (c524055)                           | SOB uses promptfoo's own provider, so a failed call gives an error result. An `afterEach` extension hook runs the assertions of the test again on the answer `'null'` (line 25) and copies their named scores.        |
| context-compiler `apps/startup-credits/promptfoo/providers/program-offers.ts` (3260473) | The provider is the app's own. For a failed call it returns `{ output: 'null', metadata: { ...metadata, failed } }` (lines 26 and 51-55).                                                                             |
| context-compiler `apps/startup-credits/promptfoo/providers/page-kinds.ts` (3260473)     | The provider is the app's own. A 401 throws, so the result is an error result (lines 54-59). Any other failure of a page returns `{ metadata: { ...metadata, failed: result.error }, output: 'null' }` (lines 60-66). |

The three places hold one piece of knowledge: a failed call is the answer of the harness, and its case keeps its expected values in the wholes. This is strike 3 of the Rule of Three, so the knowledge moves into the package. The copied-code ledger of context-compiler (`apps/startup-credits/docs/copied-code.md`) records the copies.

The fact passes the zero-consumer test: an adapter that lets its runner drop failed cases makes each ratio of sums of the package wrong. Other harnesses agree:

- HELM treats a non-fatal error as an empty completion and scores it. A fatal error stops the run with `ExecutorError` (stanford-crfm/helm 3df4125493, `src/helm/benchmark/executor.py:116-121`).
- Inspect AI does not score a failed sample by default (`docs/handling-errors.qmd:44`, inspect_ai eabac22136). With `score_on_error`, the sample keeps its `error`, its scores count in the metrics, and task-level retries still run it again (`docs/handling-errors.qmd:115-121`).
- SOB's runner keeps the answer `None` when each retry fails, and `evaluate.py` scores it as an answer that does not parse (`parse_candidate`, sob-bench da785a8 `evaluate.py:344-347`).

No harness leaves a failed case out of the metrics on purpose. Each one scores it as an empty or invalid answer, or stops the run.

## Decision

1. A failed call is an answer: the answer null, the text `'null'`. promptfoo grades it, so its case keeps its expected values in the wholes. Each family reads the answer null as no answer (decision 5).
2. `./promptfoo` gets `FailedCall`. The name is a coinage of this package. It follows the words "failed call" of `@workspace/model-calls` in context-compiler. The package still does not depend on promptfoo: `FailedCallResponse` is a plain object that a provider can return as promptfoo's `ProviderResponse`.

   ```ts
   // Proposal: no code exists yet.
   export class FailedCall {
     static readonly answer = 'null';
     constructor(readonly reason: string) {}
     response(metadata?: Readonly<Record<string, unknown>>): FailedCallResponse;
   }

   export type FailedCallResponse = {
     readonly output: typeof FailedCall.answer;
     readonly metadata: Readonly<Record<string, unknown>> & {
       readonly failed: string;
     };
   };
   ```

   A provider returns its answer, or `new FailedCall(reason).response(metadata)`. A response has no `failed?` field next to a real answer, and no boolean flag.

3. A consumer uses one of two forms. The two forms differ in kind, so the package has no option to choose between them. The consumer chooses through its own code.
   - **Its own provider returns `FailedCall.response`.** promptfoo grades the result, and `promptfoo retry <evalId>` does not run it again. This is HELM's rule for a non-fatal error. The weights of a `PromptfooAssertion` stay correct, because promptfoo grades the answer as any other answer.
   - **A built-in provider and an `afterEach` hook.** The hook grades each error result on `FailedCall.answer` and copies the named scores into the result. The result stays an error result, so `promptfoo retry <evalId>` and `--retry-errors` run it again. This is Inspect AI's `score_on_error`. The hook cannot write `namedScoreWeights`, so promptfoo gives each copied score the weight 1. This form is correct only for scorer assertions whose metrics weigh 1. The hook stays in offers-evals (strike 1 of the hook).

4. A failure of the run is not a failed call. A failure of the run is a failure that each call would have, such as a 401. The provider throws it, so the result stays an error result for `promptfoo retry <evalId>`. HELM calls it a fatal error. The rule that sorts the two kinds of failure is the consumer's: `CallFailures.reason` of `@workspace/model-calls` (context-compiler `packages/model-calls/src/call-failures.ts:23-31`) in startup-credits, and no rule in SOB, where each failure becomes `None` as in SOB's runner.
5. Each family reads the answer null as no answer:
   - In `./structured`, the scorer set reads the stated text as JSON text. JSON null is not an object or an array, so the answer is unparsed: `ParseSuccess` fails (`src/structured/scorers/parse-success.ts:5-8`, from `parsed` in `src/structured/comparison/comparison.ts:41`), and `SchemaCompliance` fails too (`compliant`, `comparison.ts:122-123`). This is SOB's `None`.
   - In `./classification`, the comparer reads the text as the label `"null"`. That label is not a class of the task. ADR 0006 gives the rule: a stated label outside the class set is a miss of its expected class, and it counts in no class.

## Considered Options

- **Leave the failed cases out.** promptfoo does this today. The recall goes up, and no harness above does it on purpose.
- **Return `error` or no output.** promptfoo does not grade it (`evaluator-BxCmvGtv.js:7940-7952`), so it is the same as leaving the case out.
- **A `failed` boolean next to the answer.** The answer of a failed call would then hold a real answer, or no answer, with a flag. That state has no meaning.
- **A hook for each consumer.** The hook cannot carry `namedScoreWeights`, so a `PromptfooAssertion` would pool wrong through it.
- **A hook in the package.** The package would then depend on promptfoo. The hook is also strike 1.
- **`FailedCall` in `./promptfoo`, with the two forms in the consumers.** This option was selected.

## Consequences

- startup-credits' providers return `new FailedCall(reason).response(metadata)`. The constant `nothing` of `program-offers.ts` and the comments that explain it go. Each provider keeps one line that points to this ADR. An invalid answer with no text answers `FailedCall.answer` too, but it is not a `FailedCall`: it keeps its `metadata.invalid`.
- offers-evals' hook uses `FailedCall.answer` in place of its literal `'null'`. Its comment gets the weight limit of decision 3.
- In startup-credits, a page whose call still fails after the AI SDK's retries gets its final answer null. `promptfoo retry` does not run it again: the eval scores the app as the app runs.
- The entry of the copied-code ledger of context-compiler goes, and #3970 closes.
- The build adds black-box tests through promptfoo's CLI, as `src/promptfoo/assertion-module.test.ts` does:
  - A case whose provider returns a `FailedCall` response keeps its expected values in the pooled whole.
  - promptfoo grades the result of a `FailedCall` response, does not count it as an error, and keeps the reason in `metadata.failed`.
  - `./structured` and `./classification` read the answer null as no answer.
  - In offers-evals: an error result that the hook grades keeps `failureReason` `ERROR`, and `promptfoo retry` runs it again.
