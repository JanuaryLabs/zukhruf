# A run log keeps each answer of a run with its case, scorecard, metadata, usage and latency

Status: proposed (2026-11-27, #6108, #6109). Design for review: no code yet.

## Context

A report shows more than the ratios of a run. The summary needs the score of each answer, the field diff needs the answer and its case, the slices need the metadata of the test, and the cost table needs the tokens and the latency of each call. `Run` of ADR 0004 holds only the scorecards of the tests, with their epochs, because `PairedBootstrap` needs nothing else.

Every surveyed library that reports runs has a record of the run, and its reports read that record:

| Library                                 | The record                                              | One answer                                                                                                     |
| --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Inspect AI                              | `EvalLog` (`inspect_ai/log`)                            | `EvalSample`: id, epoch, input, target, output, scores, metadata, model usage, time, error                     |
| .NET Microsoft.Extensions.AI.Evaluation | the results of an execution in `IEvaluationResultStore` | `ScenarioRunResult`: scenario, iteration, messages, model response, evaluation result                          |
| Go x/perf                               | a `benchfmt` file                                       | `benchfmt.Result`: name, iterations, values with units                                                         |
| promptfoo                               | an eval in its database                                 | `EvaluateResult`: test case, vars, response, named scores, metadata, repeat index, latency, token usage, error |

Inspect AI's `analysis` builds its data frames from `inspect_ai.log` alone, and .NET's Reporting package references only the core of the evaluation libraries.

## Decision

1. **The core has `RunLog`: the samples of one run, with the facts of the run.** `new RunLog(info, samples)` takes the facts and any iterable of samples, such as the adapter of a runner (ADR 0009). `RunLog<Answer, C>` is generic over the answer and the case, as the core is (ADR 0002). Its facts are an id, a label (the model or the provider, as the runner names it) and a time.
2. **A sample is one answer to one test.** It holds the test id, the epoch (promptfoo's `repeatIndex`, Inspect AI's word), the weight of the test, the case, the scorecard, the metadata of the test, the latency, and the usage when the runner measured it.
3. **A sample is answered or failed, and the type says which.** An answered sample has its answer. A failed sample has the answer null and the error (ADR 0005). There is no field that is filler for the other kind.
4. **`Usage` holds the tokens and the cost of one call.** Input tokens, output tokens, the input tokens that the provider read from its prompt cache, and the cost when the runner knows its price.
5. **A sample says whether its answer was replayed.** A replayed answer came from a cache of the runner or the harness, with no new call (promptfoo's `response.cached`). It is not the provider's prompt cache of point 4. A replayed sample has no usage: it spent nothing. A page shows what a run spent on its new calls and counts its replayed answers apart, as Braintrust and promptfoo show cached work apart from spend (offers-evals #6114, closed 2026-11-27: no harness has to keep the usage of a first call).
6. **A run log gives the `Run` of ADR 0004.** `log.run()` adds the scorecard of each sample, so `PairedBootstrap` and `Totals` read a log without a second reader.
7. **Two samples of one test and epoch are a `RangeError`.** The reader of a runner keeps one result for each (ADR 0009).
8. **`new RunPair(baseline, change)` holds two logs on the same tests, and refuses others.** A test that only one log has, or a test with another weight, is a `RangeError` that names each such test, the rule of ADR 0004, point 4, moved to the moment the pair is built. A building block of two runs takes a `RunPair`, so it never meets two logs with different tests.

## Consequences

- `Run` stays as it is. A caller that has only scorecards still builds a `Run`.
- `RunLog`, `Sample` and `RunPair` are value objects: built with `new`, never changed. Ezz ruled for "Adapter + Iterator" over a static reader (2026-11-27).
- The zero-consumer test: a runner of any kind gives one record for each answer, so the record is a fact of the eval, not of one host.
- The words: a run log and a sample. "Log" is Inspect AI's word for the record of a run; "sample" is its word for one answer and is the word of `Bootstrap` for one resampled unit.
