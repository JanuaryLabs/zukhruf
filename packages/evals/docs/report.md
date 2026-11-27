# Reports: `@zukhruf/evals/report`

> **Design for review (#6108).** No code of this page exists yet: not `RunLog`, `Section` and `Block` of the core, not `PromptfooLog` of `./promptfoo`, not `./report`, and not the sections of `./structured`. Ezz rules on each decision before any code. The ADRs of the decisions are [core 0007](adr/0007-a-run-log-keeps-each-answer-of-a-run-with-its-case-scorecard-metadata-usage-and-latency.md), [core 0008](adr/0008-a-report-is-sections-of-blocks-the-core-holds-the-blocks-and-report-renders-them.md), [core 0009](adr/0009-the-promptfoo-adapter-reads-a-run-into-a-run-log-with-the-latest-result-of-each-answer.md), [report 0001](adr/report/0001-reports-are-grouped-by-their-input-one-run-two-runs-or-many-runs.md) to [report 0005](adr/report/0005-repeat-spread-reads-the-scores-of-the-epochs-not-the-pass-flags-of-promptfoo.md), and [structured 0014](adr/structured/0014-field-errors-and-the-field-diff-pair-items-as-the-scorer-pairs-them.md).

A runner runs the tests and stores what each answer scored. A report reads one stored run, two runs on the same tests, or many runs, and shows on one page what the numbers say. promptfoo is the runner of every eval (Ezz, 2026-11-27), and its web viewer is not the report (Ezz, 2026-11-24). This page replaces the line "It does not … show them" of the README.

## The parts

| Part                        | Import path                 | Job                                                                                                                        |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `RunLog`, `Sample`, `Usage` | `@zukhruf/evals`            | The record of one run: each answer with its test, epoch, case, scorecard, metadata, latency and usage.                     |
| `Section`, `Block`          | `@zukhruf/evals`            | The content of a report: a claim and the blocks (tables, charts, value pairs) that show its numbers.                       |
| `PromptfooLog`              | `@zukhruf/evals/promptfoo`  | Reads the results of a promptfoo run (`afterAll` or `promptfoo export`) into a `RunLog`.                                   |
| `RunReport`                 | `@zukhruf/evals/report`     | The report of one run: the summary, the slices, the repeat spread, and the sections of the families.                       |
| `PairReport`                | `@zukhruf/evals/report`     | The report of two runs on the same tests: the verdict of each score, the tests that each run won, and the family sections. |
| `TrendReport`               | `@zukhruf/evals/report`     | The report of many runs: each score of each run, in the order of the runs.                                                 |
| `FieldErrors`, `FieldDiff`  | `@zukhruf/evals/structured` | The sections of structured answers: the errors of each field and item, and the expected value beside each answer.          |

`./report` imports only the core, as every subpath does ([ADR 0001](adr/0001-one-package-with-a-subpath-for-each-shape-of-answer.md)). A family gives its own sections as `Section` values of the core, so `./report` never imports a family, and a family never imports `./report`. The host passes the sections of its family to the report.

## The kinds of report

Two surveys of 2026-11-27 read what structured-output evals show (26 kinds from about 30 sources) and where libraries keep the code of their reports (11 libraries). The kinds below are the ones that Ezz chose. Each kind is a section of the report of its input ([report ADR 0001](adr/report/0001-reports-are-grouped-by-their-input-one-run-two-runs-or-many-runs.md)).

| Section            | Report        | Question                                                    | Who shows it                                                                                       |
| ------------------ | ------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Summary            | `RunReport`   | How good is this run on each score, and does it meet a bar? | SOB Table 2 (each metric with its 95% interval); Braintrust summary; Inspect AI's headline         |
| Valid and correct  | `RunReport`   | Does a valid answer hide wrong values?                      | SOB Figure 2 (JSON pass rate beside value accuracy); ExtractBench Table 5                          |
| Slices             | `RunReport`   | Where does a score drop?                                    | SOB by schema complexity; ExtractBench by domain; Kleister by length                               |
| Repeat spread      | `RunReport`   | Do the epochs of a test agree?                              | Inspect AI epochs; Braintrust "Group by input"; Kleister ± SD over 3 runs                          |
| Cost and latency   | `RunReport`   | What does a run cost, and how long does an answer take?     | Braintrust metric columns; Phoenix; micro1 (p50, p90)                                              |
| Field errors       | `RunReport`   | Which fields and items fail, and how?                       | nervaluate (correct, incorrect, missed, spurious); Kleister per field; LLMStructBench (MK, MV, WV) |
| Verdicts           | `PairReport`  | Is the change better than the baseline beyond chance?       | Braintrust improvements and regressions; Miller 2024 (paired difference with its interval)         |
| Tests won and lost | `PairReport`  | Which tests moved, and how far?                             | Weave's scatter of two runs; Braintrust's diff of each row                                         |
| Field diff         | both          | What exactly is wrong in this answer?                       | SOB Table 10 (by hand). No surveyed tool has a diff that knows the fields; each one diffs text.    |
| Trend              | `TrendReport` | Where do the scores go over the runs?                       | Phoenix's chart strip; LangSmith; HELM                                                             |

Later: a report of more than two runs side by side, a source view that marks each value in the input (Google LangExtract; it needs a quote or an offset in each answer), and clusters of errors. Never: a server, a viewer app, a runner, a store, or an LLM judge.

## Read a promptfoo run

```ts
import { PromptfooLog } from '@zukhruf/evals/promptfoo';

// In an afterAll extension of promptfoo: context.results.
// After a run: the results.results of `promptfoo export eval <id> -o run.json`.
const log = PromptfooLog.read(results, {
  info: { id: evalId, label: 'claude-haiku-5-5', createdAt },
  test: (result) => result.testCase.description, // the test id (ADR 0004, point 1)
  cases: pages, // the CaseReader of the eval reads the case from the vars
  answer: (output) => JsonValue.from(output), // the stored output as the comparer reads it
});
```

The reader keeps the newest result of each test and epoch, so a run after `--retry-errors` has one sample per answer ([core ADR 0009](adr/0009-the-promptfoo-adapter-reads-a-run-into-a-run-log-with-the-latest-result-of-each-answer.md)). The ratio of each name is `namedScores[name] × namedScoreWeights[name]` over `namedScoreWeights[name]`, so `Totals` of the log gives the number that promptfoo's column header shows. A failed call is a sample whose answer is null, with its error ([ADR 0005](adr/0005-a-failed-call-is-the-answer-null.md)).

## Report one run

```ts
import { RunReport } from '@zukhruf/evals/report';
import { FieldDiff, FieldErrors } from '@zukhruf/evals/structured';

const report = RunReport.from(log, {
  title: 'offers on the tuning pages',
  // The three bars of offers' pass-bar.md.
  scores: [
    { name: 'values_recall', higherIsBetter: true, bar: { atLeast: 0.88 } },
    {
      name: 'values_precision',
      higherIsBetter: true,
      bar: { atLeast: 0.88, slice: ['page', 'offers'] },
    },
    {
      name: 'values_f1',
      higherIsBetter: true,
      bar: { atLeast: 0.95, slice: ['page', 'empty'] },
    },
  ],
  slices: [
    { name: 'labels', key: (sample) => String(sample.metadata.labels) },
    // The host knows what an empty page is: here, an expected value with no offer.
    {
      name: 'page',
      key: (sample) => (hasNoOffer(sample.case) ? 'empty' : 'offers'),
    },
  ],
  sections: [
    new FieldErrors({ comparer }),
    new FieldDiff({ comparer, worst: 20 }),
  ],
  bootstrap: { nResamples: 2000, randomIndex, interval },
});
await writeFile(`reports/${log.info.id}.html`, report.toHtml());
```

The summary shows each score with its 95% interval and, when the score has a bar, whether the interval is above, across or below it. The interval resamples tests, with all epochs of a test, and recomputes the statistic of the score: a ratio of sums for a score per item, a mean for a score per row ([report ADR 0004](adr/report/0004-a-summary-interval-bootstraps-the-statistic-of-the-score-and-verdicts-of-many-scores-are-corrected-with-holm.md); it waits on #4234). A slice gives the same table for each value of its key. The repeat spread lists the tests whose score is not the same in each epoch, widest first ([report ADR 0005](adr/report/0005-repeat-spread-reads-the-scores-of-the-epochs-not-the-pass-flags-of-promptfoo.md)).

## Compare two runs

```ts
const pair = PairReport.from(baseline, change, {
  ...options, // the scores, the slices, the sections and the bootstrap of RunReport
  primary: 'values_f1', // optional: the one score chosen before the runs
});
```

The verdict of each score comes from `PairedBootstrap` (ADR 0004). The p-values of all scores but the primary one are corrected together with Holm ([report ADR 0004](adr/report/0004-a-summary-interval-bootstraps-the-statistic-of-the-score-and-verdicts-of-many-scores-are-corrected-with-holm.md); Holm moves to `@zukhruf/statistics`, #6111). Two logs with different tests are a `RangeError`, as `PairedBootstrap` refuses them. The tests that each run won come as a scatter (one point for each test, the baseline on x and the change on y) and as a table, largest difference first.

## Follow many runs

```ts
const trend = TrendReport.from([first, second, third], options);
```

The runs keep the order that the caller gives. Each score shows its value and its interval in each run. A test that only some runs have counts in each run that has it, and the page says how many tests each run has.

## When each report is written

The input of a report sets when it can be written ([report ADR 0001](adr/report/0001-reports-are-grouped-by-their-input-one-run-two-runs-or-many-runs.md)). The host decides where the page goes.

| Report        | Input                      | When                                     | promptfoo seam                                                     |
| ------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `RunReport`   | one run                    | at the end of each run                   | an `afterAll` extension (`context.results`), as SOB's summary does |
| `PairReport`  | two runs on the same tests | when both runs exist, such as two models | `promptfoo export eval <id>` of each run, in a script of the host  |
| `TrendReport` | many runs                  | when the reader asks                     | `promptfoo export eval <id>` of each run                           |

promptfoo has no reporter API: its only reporter class prints the progress of a CI run, and `afterAll` returns nothing that promptfoo keeps ("intended for side effects"). Its viewer and its `-o html` output belong to the runner.

## The page

`toHtml()` gives one page with no `<html>`, `<head>` or `<body>`, as `@zukhruf/mteb/report` does: a browser opens it, and an artifact on claude.ai wraps it. `toMarkdown()` gives the same sections as Markdown, for a commit message or a doc such as offers' `pass-bar.md`. Each section title is a claim that comes from its numbers, such as "DeepSeek is better than Haiku on values_recall (+4.6 [+0.1, +14.1])" ([report ADR 0002](adr/report/0002-each-section-title-is-a-claim-that-its-numbers-give.md)). The page is text in the base layer, with no UI framework ([report ADR 0003](adr/report/0003-a-page-is-html-or-markdown-text-in-the-base-layer.md)).

## Field errors and the field diff

`FieldErrors` and `FieldDiff` of `./structured` compare each answer again with the comparer of the eval (the `TreeWalk` with the spec of its scores), because promptfoo stores the ratios but not the pairs. They make no model call. A field error is one of four classes, the words of SemEval 2013 task 9.1 as nervaluate reports them:

| Class     | A leaf                           | An item of an array               |
| --------- | -------------------------------- | --------------------------------- |
| correct   | both sides have it, and agree    | paired, and every leaf is correct |
| incorrect | both sides have it, and disagree | paired, with a leaf that is not   |
| missed    | only the expected side has it    | an unpaired expected item         |
| spurious  | only the answer has it           | an unpaired stated item           |

The field diff pairs the items as the scorer pairs them ([structured ADR 0014](adr/structured/0014-field-errors-and-the-field-diff-pair-items-as-the-scorer-pairs-them.md)). jsondiffpatch 0.7.7 pairs by position, or by a hash of each item: on two offers in the other order and one wrong amount, it reported 6 changed fields where `ByBestMatch` finds 1 (probe of 2026-11-27).

## Why no package from npm

Searched on 2026-11-27: stdlib-js (`report`, `diff`), npm ("llm eval report html", "eval results report structured output", "json diff html formatter", "evaluation leaderboard report"), Node 26's built-ins.

| Candidate                     | Version, release    | Weekly downloads | Why it does not do the job                                                                        |
| ----------------------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| promptfoo (viewer, `-o html`) | 0.126.0, 2026-11-18 | 1,107,449        | The runner's own view: means of rows, no intervals, no verdicts, no field errors; rejected by Ezz |
| `@vitest-evals/report-ui`     | 0.18.1, 2026-11-07  | 224,671          | Reads only vitest-evals artifacts                                                                 |
| evalite                       | 0.19.0, 2025-11-06  | 475,764          | Its own runner and UI                                                                             |
| allure-js-commons             | 3.15.0, 2026-11-17  | 3,203,588        | Test reports: passed and failed, no scores                                                        |
| jsondiffpatch                 | 0.7.7, 2026-10-29   | 3,137,612        | A diff only, and it pairs items in another way than the scorer                                    |
| `@deepagents/evals`           | 7.51.0, 2026-11-27  | 11,789           | Its own runner and store; means, no intervals; to be retired (#3881)                              |
| Node 26 `util.diff`           | built in            | —                | A Myers diff of strings or arrays, by position                                                    |

## Where reports live in other libraries

| Pattern                                         | Libraries                                                                                                                                         | This package                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A display beside its metric                     | scikit-learn (`classification_report`, `sklearn/metrics/_plot`), torchmetrics (`Metric.plot`), nervaluate                                         | `FieldErrors`, `FieldDiff` in `./structured` |
| A reporting part over the core and a run format | .NET `Microsoft.Extensions.AI.Evaluation.Reporting` (references only the core), Go benchstat over `benchfmt` and `benchmath`, HELM `presentation` | `./report` over `RunLog`                     |
| A run record that reports read                  | Inspect AI `EvalLog` and its `analysis` frames, .NET `ScenarioRunResult`, Go `benchfmt.Result`                                                    | `RunLog` in the core                         |
| The runner shows its runs                       | promptfoo, lm-evaluation-harness, the Inspect AI viewer, the MTEB leaderboard                                                                     | not taken: promptfoo's view was rejected     |

In each library, the report imports the result types of the scorers or the run format, and no scorer imports the report.

## What changes for a caller

| Before                                                                                                       | After                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| README: "It does not run a harness, load a dataset, store results or show them."                             | It does not run a harness, load a dataset or store results. `./report` shows them. |
| CONTEXT.md, Runner: "…stores the results, shows them…"                                                       | The runner runs and stores; the report shows.                                      |
| Each eval reads promptfoo rows by hand (offers' `climb.ts` and `held-out-compare.ts`, SOB's `scored-row.ts`) | `PromptfooLog.read` (#6110); the copies go (offers-evals #4593, #6115)             |
| Holm is in `@zukhruf/mteb` only                                                                              | `@zukhruf/statistics` (#6111)                                                      |
| #3881 (2026-11-06): borrow the reporters and the viewer from promptfoo                                       | The reports are this package's; promptfoo stays the runner                         |

## The gaps this design depends on

| Gap                                                                                                       | Item                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------- |
| `Bootstrap` averages the value of each scorecard, so the interval of a score per item is not its interval | #4234 (offers-evals #4286) |
| No run record in the core                                                                                 | #6109                      |
| `./promptfoo` cannot read a run                                                                           | #6110                      |
| No multiple-comparison correction in `@zukhruf/statistics`                                                | #6111                      |
| A replayed answer of offers-evals' provider keeps one cached token total, so its cost has no price        | offers-evals #6114         |

## Who uses each part

| Consumer                   | Uses                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| offers-evals `apps/offers` | `PromptfooLog`, `RunReport`, `PairReport` (Haiku and DeepSeek on each commit), `TrendReport`, `FieldErrors`, `FieldDiff` |
| offers-evals `apps/sob`    | `PromptfooLog` (in place of `rowOf`), `RunReport` beside SOB's own summary, which stays SOB's port                       |
| `@zukhruf/mteb`, later     | `./ranking` sections on `./report`, when mteb runs on promptfoo (#6112)                                                  |
