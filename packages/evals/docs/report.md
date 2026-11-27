# Reports: `@zukhruf/evals/report`

> **Design for review (#6108), built in parts.** Built: `Bootstrap` over a run (ADR 0010), `Holm` of `@zukhruf/statistics`, `RunLog`, `Sample`, `Usage`, `Call` and `RunPair` of the core (ADR 0007), `PromptfooSamples` of `./promptfoo` (ADR 0009), the primitives and `Section` of the core (ADR 0008), `Page`, `HtmlRenderer` and `MarkdownRenderer` of `./report` (report ADR 0003), `Summary`, `Slices` and `ValidityGap` of `./report`, on `Run#total` and `Bootstrap` (report ADR 0004), and `RepeatSpread` of `./report` (report ADR 0005). Not built yet: the other building blocks of `./report` and those of `./structured`; "The order of the work" below is the order they come in. Ezz ruled on the shape on 2026-11-27 (by input; a page that the host composes; primitives drawn by renderers; an adapter that gives samples; the gaps of the statistics first; five classes of field error). The ADRs: [core 0007](adr/0007-a-run-log-keeps-each-answer-of-a-run-with-its-case-scorecard-metadata-usage-and-latency.md), [core 0008](adr/0008-primitives-are-data-in-the-core-and-the-renderers-of-report-visit-them.md), [core 0009](adr/0009-the-promptfoo-adapter-gives-the-samples-of-a-run-with-the-latest-result-of-each-answer.md), [report 0001](adr/report/0001-a-host-composes-a-page-of-sections-and-each-section-is-built-from-its-input.md) to [report 0005](adr/report/0005-repeat-spread-reads-the-scores-of-the-epochs-not-the-pass-flags-of-promptfoo.md), and [structured 0014](adr/structured/0014-field-errors-have-five-classes-and-the-field-diff-pairs-items-as-the-scorer-pairs-them.md).

A runner runs the tests and stores what each answer scored. A report reads one stored run, two runs on the same tests, or many runs, and shows on one page what the numbers say. promptfoo is the runner of every eval (Ezz, 2026-11-27), and its web viewer is not the report (Ezz, 2026-11-24). This page replaces the line "It does not … show them" of the README.

## The parts

| Part                                                                                                    | Import path                 | Job                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `RunLog`, `Sample`, `Usage`                                                                             | `@zukhruf/evals`            | The record of one run: each answer with its test, epoch, case, scorecard, metadata, latency and usage.  |
| `RunPair`                                                                                               | `@zukhruf/evals`            | Two run logs on the same tests. A pair of runs with other tests cannot be built.                        |
| `Section`                                                                                               | `@zukhruf/evals`            | What a building block gives: a claim and the primitives that show its numbers.                          |
| `Table`, `Bars`, `Scatter`, `Line`, `Heatmap`, `ValuePairs`, `Note`                                     | `@zukhruf/evals`            | The primitives: data to draw, with no HTML.                                                             |
| `PromptfooSamples`                                                                                      | `@zukhruf/evals/promptfoo`  | Adapts the results of a promptfoo run (`afterAll` or `promptfoo export`) into the samples of a run log. |
| `Page`, `HtmlRenderer`, `MarkdownRenderer`                                                              | `@zukhruf/evals/report`     | A page of sections, and the renderers that draw each primitive.                                         |
| `Summary`, `ValidityGap`, `Slices`, `RepeatSpread`, `CostAndLatency`, `Verdicts`, `TestsMoved`, `Trend` | `@zukhruf/evals/report`     | The building blocks of every family.                                                                    |
| `FieldErrors`, `FieldDiff`                                                                              | `@zukhruf/evals/structured` | The building blocks of structured answers.                                                              |

`./report` imports only the core, as every subpath does ([ADR 0001](adr/0001-one-package-with-a-subpath-for-each-shape-of-answer.md)). A family builds its sections from the primitives of the core, so `./report` never imports a family, and a family never imports `./report`. The host puts the sections of `./report` and of its family on one page.

## The building blocks

Two surveys of 2026-11-27 read what structured-output evals show (26 kinds from about 30 sources) and where libraries keep the code of their reports (11 libraries). Ezz chose the kinds below. Each one is a building block, and its input says when it can be built ([report ADR 0001](adr/report/0001-a-host-composes-a-page-of-sections-and-each-section-is-built-from-its-input.md)).

| Building block   | Input                 | Question                                                    | Who shows it                                                                                                |
| ---------------- | --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Summary`        | `RunLog`              | How good is this run on each score, and does it meet a bar? | SOB Table 2 (each metric with its 95% interval); Braintrust summary; Inspect AI's headline                  |
| `ValidityGap`    | `RunLog`              | Does a valid answer hide wrong values?                      | SOB Figure 2 (JSON pass rate beside value accuracy); ExtractBench Table 5                                   |
| `Slices`         | `RunLog`              | Where does a score drop?                                    | SOB by schema complexity; ExtractBench by domain; Kleister by length                                        |
| `RepeatSpread`   | `RunLog`              | Do the epochs of a test agree?                              | Inspect AI epochs; Braintrust "Group by input"; Kleister ± SD over 3 runs                                   |
| `CostAndLatency` | `RunLog`              | What does a run cost, and how long does an answer take?     | Braintrust metric columns; Phoenix; micro1 (p50, p90)                                                       |
| `FieldErrors`    | `RunLog`              | Which fields and items fail, and how?                       | nervaluate (correct, incorrect, partial, missed, spurious); Kleister per field; LLMStructBench (MK, MV, WV) |
| `FieldDiff`      | `RunLog` or `RunPair` | What exactly is wrong in this answer?                       | SOB Table 10 (by hand). No surveyed tool has a diff that knows the fields; each one diffs text.             |
| `Verdicts`       | `RunPair`             | Is the change better than the baseline beyond chance?       | Braintrust improvements and regressions; Miller 2024 (paired difference with its interval)                  |
| `TestsMoved`     | `RunPair`             | Which tests moved, and how far?                             | Weave's scatter of two runs; Braintrust's diff of each row                                                  |
| `Trend`          | many `RunLog`s        | Where do the scores go over the runs?                       | Phoenix's chart strip; LangSmith; HELM                                                                      |

Later: a page of more than two runs side by side, a source view that marks each value in the input (Google LangExtract; it needs a quote or an offset in each answer), and clusters of errors. Never: a server, a viewer app, a runner, a store, or an LLM judge.

## Read a promptfoo run

```ts
import { RunLog } from '@zukhruf/evals';
import { PromptfooSamples } from '@zukhruf/evals/promptfoo';

// In an afterAll extension of promptfoo: context.results.
// After a run: the results.results of `promptfoo export eval <id> -o run.json`.
const log = new RunLog(
  { id: evalId, label: 'claude-haiku-5-5', createdAt },
  new PromptfooSamples(results, {
    test: (result) => result.testCase.description, // the test id (ADR 0004, point 1)
    cases: pages, // the CaseReader of the eval reads the case from the vars
    answer: (output) => JsonValue.from(output), // the stored output as the comparer reads it
  }),
);
```

`PromptfooSamples` is an iterable of samples. It keeps the newest result of each test and epoch, so a run after `--retry-errors` has one sample per answer ([core ADR 0009](adr/0009-the-promptfoo-adapter-gives-the-samples-of-a-run-with-the-latest-result-of-each-answer.md)). The ratio of each name is `namedScores[name] × namedScoreWeights[name]` over `namedScoreWeights[name]`, so `Totals` of the log gives the number that promptfoo's column header shows. A failed call is a sample whose answer is null, with its error ([ADR 0005](adr/0005-a-failed-call-is-the-answer-null.md)). `RunLog` takes any iterable of samples, so a reader of another runner gives its own.

## A page of one run

```ts
import {
  HtmlRenderer,
  Page,
  RepeatSpread,
  Slices,
  Summary,
} from '@zukhruf/evals/report';
import { FieldDiff, FieldErrors } from '@zukhruf/evals/structured';

// The three bars of offers' pass-bar.md.
const scores = [
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
];
const slices = [
  { name: 'labels', key: (sample) => String(sample.metadata.labels) },
  // The host knows what an empty page is: here, an expected value with no offer.
  {
    name: 'page',
    key: (sample) => (hasNoOffer(sample.case) ? 'empty' : 'offers'),
  },
];

const page = new Page('offers · eval-ove', [
  new Summary(log, { scores, slices, bootstrap }),
  new Slices(log, { scores, slices, bootstrap }),
  new RepeatSpread(log, { scores, widest: 20 }),
  new FieldErrors(log, { comparer }),
  new FieldDiff(log, { comparer, worst: 20 }),
]);
await writeFile(`reports/${log.info.id}.html`, new HtmlRenderer().render(page));
```

`Summary` shows each score with its interval (its header names the level of the caller's interval method, such as "95% interval") and, when the score has a bar, whether the interval is above, across or below it. The interval resamples tests, with all epochs of a test, and recomputes the statistic of the score: a ratio of sums for a score per item, a mean for a score per row ([report ADR 0004](adr/report/0004-a-summary-interval-bootstraps-the-statistic-of-the-score-and-verdicts-of-many-scores-are-corrected-with-holm.md); built after #4234). `Slices` gives a table for each slice: a row for each key, in number order, with its tests and each score's value and interval on the key's samples; it reads no bar, since a bar holds for the population it was set on, and its claim names the key where the first score is worst. `ValidityGap` takes the name of a gate's ratio, such as SOB's schema compliance, and gives the share of valid answers (the gate held), each score over all answers and over the valid ones, and how many valid answers have a wrong value of the score. `RepeatSpread` lists the tests whose score is not the same in each epoch, widest first ([report ADR 0005](adr/report/0005-repeat-spread-reads-the-scores-of-the-epochs-not-the-pass-flags-of-promptfoo.md)).

## A page of two runs

```ts
const pair = new RunPair(baseline, change); // a RangeError when the tests differ

const page = new Page('Haiku and DeepSeek on 7eea4f3', [
  new Verdicts(pair, { scores, bootstrap, primary: 'values_f1' }),
  new TestsMoved(pair, { score: 'values_recall' }),
  new FieldDiff(pair, { comparer, worst: 20 }),
]);
```

`Verdicts` gives the verdict of each score from `PairedBootstrap` (ADR 0004). The p-values of all scores but the primary one, chosen before the runs, are corrected together with Holm ([report ADR 0004](adr/report/0004-a-summary-interval-bootstraps-the-statistic-of-the-score-and-verdicts-of-many-scores-are-corrected-with-holm.md); Holm moves to `@zukhruf/statistics` first, #6111). `RunPair` refuses two logs with different tests, so no building block of a pair checks it again. `TestsMoved` shows a scatter (one point for each test, the baseline on x and the change on y) and a table, largest difference first. `FieldDiff` of a pair shows the two answers of a test beside its case.

## A page of many runs

```ts
const page = new Page('offers over the climb', [
  new Trend([first, second, third], { scores, bootstrap }),
]);
```

`Trend` keeps the order that the caller gives, and takes two runs or more (a tuple type). Each score shows its value and its interval in each run. A test that only some runs have counts in each run that has it, and the page says how many tests each run has.

## When each page is written

A building block can be built when its input exists, so the input sets when a page can be written ([report ADR 0001](adr/report/0001-a-host-composes-a-page-of-sections-and-each-section-is-built-from-its-input.md)). The host decides which blocks go on a page, and where the page goes.

| Input       | When                                     | promptfoo seam                                                     |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------ |
| a `RunLog`  | at the end of each run                   | an `afterAll` extension (`context.results`), as SOB's summary does |
| a `RunPair` | when both runs exist, such as two models | `promptfoo export eval <id>` of each run, in a script of the host  |
| many runs   | when the reader asks                     | `promptfoo export eval <id>` of each run                           |

promptfoo has no reporter API: its only reporter class prints the progress of a CI run, and `afterAll` returns nothing that promptfoo keeps ("intended for side effects"). Its viewer and its `-o html` output belong to the runner.

## The page

`new HtmlRenderer().render(page)` gives one page with no `<html>`, `<head>` or `<body>`, as `@zukhruf/mteb/report` does: a browser opens it, and an artifact on claude.ai wraps it. `new MarkdownRenderer().render(page)` gives the same sections as Markdown, for a commit message or a doc such as offers' `pass-bar.md`. Each section title is a claim that comes from its numbers, such as "No difference beyond chance on values_recall (+4.6 [−0.6, +12.7])" ([report ADR 0002](adr/report/0002-each-section-title-is-a-claim-that-its-numbers-give.md)). The page is text in the base layer, with no UI framework ([report ADR 0003](adr/report/0003-a-page-is-html-or-markdown-text-in-the-base-layer.md)).

## The patterns, and why

| Part                                                      | Pattern                  | Why this one                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunLog`, `Sample`, `RunPair`                             | Value objects            | They hold facts and never change. `RunPair` checks its two logs when it is built, so a pair with other tests is a state that no code can reach (Make Illegal States Unrepresentable).                                                       |
| `PromptfooSamples`                                        | Adapter, and an Iterator | It adapts promptfoo's `EvaluateResult` rows to the `Sample` that the core knows. As an iterable, it lets `RunLog` take the samples of any runner.                                                                                           |
| the test id, the answer reader, `CaseReader`, a slice key | Strategy                 | The host knows them, not the package. `CaseReader` is the strategy that the assertions already take.                                                                                                                                        |
| `Page` and the building blocks                            | Composite                | The host composes a page at the call site and sees each part of it (Ezz: no helper that hides its parts). A building block is a leaf; a page is the composite.                                                                              |
| the primitives and the renderers                          | Visitor                  | The primitives are a closed set, and the formats grow (HTML, Markdown, later others). Each primitive has `accept(visitor)`; a renderer has one method for each primitive, so a new primitive does not compile until each renderer draws it. |
| no static factory                                         | —                        | Each part is built in memory, at once, with `new`. `@zukhruf/mteb/report` has `Report.from` because it reads its results from files, and a constructor cannot be async.                                                                     |

## Field errors and the field diff

`FieldErrors` and `FieldDiff` of `./structured` compare each answer again with the comparer of the eval (the `TreeWalk` with the spec of its scores), because promptfoo stores the ratios but not the pairs. They make no model call. A field error is one of five classes, the words of SemEval 2013 task 9.1 as nervaluate reports them ([structured ADR 0014](adr/structured/0014-field-errors-have-five-classes-and-the-field-diff-pairs-items-as-the-scorer-pairs-them.md)):

| Class     | A leaf                                                                       | An item of an array                           |
| --------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| correct   | both sides have it, and they agree                                           | paired, and every leaf is correct             |
| partial   | both sides have it, they disagree, and they share a word (token overlap > 0) | paired, with some leaves correct and some not |
| incorrect | both sides have it, they disagree, and they share no word                    | paired, and no leaf is correct                |
| missed    | only the expected side has it                                                | an unpaired expected item                     |
| spurious  | only the answer has it                                                       | an unpaired stated item                       |

The field diff pairs the items as the scorer pairs them. jsondiffpatch 0.7.7 pairs by position, or by a hash of each item: on two offers in the other order and one wrong amount, it reported 6 changed fields where `ByBestMatch` finds 1 (probe of 2026-11-27).

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
| Data that a renderer draws                      | HELM `Table` and `Cell` (drawn by its frontend), Inspect AI `ViewerConfig`                                                                        | the primitives of the core                   |
| The runner shows its runs                       | promptfoo, lm-evaluation-harness, the Inspect AI viewer, the MTEB leaderboard                                                                     | not taken: promptfoo's view was rejected     |

In each library, the report imports the result types of the scorers or the run format, and no scorer imports the report.

## What changes for a caller

| Before                                                                                                       | After                                                                              |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| README: "It does not run a harness, load a dataset, store results or show them."                             | It does not run a harness, load a dataset or store results. `./report` shows them. |
| CONTEXT.md, Runner: "…stores the results, shows them…"                                                       | The runner runs and stores; a page shows.                                          |
| Each eval reads promptfoo rows by hand (offers' `climb.ts` and `held-out-compare.ts`, SOB's `scored-row.ts`) | `PromptfooSamples` (#6110); the copies go (offers-evals #4593, #6115)              |
| Holm is in `@zukhruf/mteb` only                                                                              | `@zukhruf/statistics` (#6111)                                                      |
| #3881 (2026-11-06): borrow the reporters and the viewer from promptfoo                                       | The pages are this package's; promptfoo stays the runner                           |

## The order of the work

Ezz, 2026-11-27: the gaps of the statistics come first, so no page ever shows a wrong interval.

1. Done: `Bootstrap` takes the statistic of `Totals` (#4234, 0b542c02).
2. Done: Holm in `@zukhruf/statistics`, and mteb imports it (#6111, f1ba7079).
3. Done: `RunLog`, `Sample`, `RunPair` in the core (#6109).
4. Done: `PromptfooSamples` in `./promptfoo` (#6110).
5. The primitives in the core (done: 036f7232, its message fixed forward by d570241a), then `./report`: `Page` and the renderers (done), the building blocks (#6108): `Summary` (done), `Slices` (done), `RepeatSpread` (done) and `ValidityGap` (done), on `Run#total` of the core, the value whose interval `Bootstrap` gives.
6. `FieldErrors` and `FieldDiff` in `./structured` (#6108).
7. offers-evals moves onto them: offers' pages, and SOB's reader (#4593, #6115).

## The gaps this design depends on

| Gap                                                                                                       | Item                             |
| --------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Bootstrap` averages the value of each scorecard, so the interval of a score per item is not its interval | done: #4234 (offers-evals #4286) |
| No run record in the core                                                                                 | done: #6109                      |
| `./promptfoo` cannot read a run                                                                           | done: #6110                      |
| No multiple-comparison correction in `@zukhruf/statistics`                                                | done: #6111                      |

A replayed answer cost nothing this time, but its answer had a cost. So `CostAndLatency` shows both, as promptfoo keeps a cached answer's tokens and counts its incurred tokens and cost apart (`incurredTokenUsage`, `incurredCost`): what the run spent (its samples that were not replayed), what its answers cost (each sample with the usage of the call that gave it), and how many answers were replayed (offers-evals #6114: offers' provider reports the stored usage of a replay).

## Who uses each part

| Consumer                   | Uses                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| offers-evals `apps/offers` | `PromptfooSamples`, `RunLog`, `RunPair`, `Page` with every building block (Haiku and DeepSeek on each commit), `FieldErrors`, `FieldDiff`   |
| offers-evals `apps/sob`    | `PromptfooSamples` (in place of `rowOf`), and a page of `Summary`, `ValidityGap`, `Slices` beside SOB's own summary, which stays SOB's port |
| `@zukhruf/mteb`, later     | `./ranking` building blocks on a `Page`, when mteb runs on promptfoo (#6112)                                                                |
