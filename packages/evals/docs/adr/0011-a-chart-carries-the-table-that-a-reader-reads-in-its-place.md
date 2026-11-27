# A chart carries the table that a reader reads in its place

Status: Accepted 2026-11-28 (backlog #6244).

Decision-makers: Ezz, on the split between three forms of a chart in Markdown that the survey below did not decide ("Yes: a chart carries its table", chosen over "Markdown skips charts" and "a text chart in a code block"); the session that built it, on the rest from the survey and the measurement.

`Summary` gave a `Table` (score, value, interval, bar, verdict) and a `Bars` of the same rows. `MarkdownRenderer` drew a `Bars` as its own data table (Bar, Value, Low, High) and its marks as a second table (Mark, At), so the Markdown of a Summary printed each value and each interval twice. `Trend` did the same: its `Line` drew as a Step table of the value and the interval of each run, and its `Table` held the same cells and the created day and the tests of each run. A renderer visits one primitive at a time (ADR 0008), so it cannot see that a section has the same numbers in a second primitive. Markdown is read by people in a doc or a commit and by agents, who pay for each token, so the repetition costs.

A survey of 2026-11-28 read how the leading tools draw a chart in Markdown:

- **8 tools draw a chart in Markdown as one data table, and no chart:** hyperfine ([markup.rs](https://github.com/sharkdp/hyperfine/blob/master/src/export/markup.rs), `mean ± stddev` in one cell), mitata ([main.mjs](https://github.com/evanwashere/mitata/blob/main/src/main.mjs), its `markdown` format; its bar and box plots are in the terminal format only), github-action-benchmark ([write.ts](https://github.com/benchmark-action/github-action-benchmark/blob/master/src/write.ts), the chart is on its gh-pages page), Bencher ([bencher_comment lib.rs](https://github.com/bencherdev/bencher/blob/main/lib/bencher_comment/src/lib.rs), a "view plot" link for each row), CodSpeed (a real comment on [riscv/sail-riscv#2139](https://github.com/riscv/sail-riscv/pull/2139)), lm-evaluation-harness ([utils.py](https://github.com/EleutherAI/lm-evaluation-harness/blob/main/lm_eval/utils.py) `make_table`, a `±` and a Stderr column), mteb ([mock_run.py](https://github.com/embeddings-benchmark/mteb/blob/main/mteb/mocks/mock_run.py) `to_markdown`), and `@actions/core` ([summary.ts](https://github.com/actions/toolkit/blob/main/packages/core/src/summary.ts), which has `addTable`, `addImage` and `addCodeBlock`, and no chart).
- **None of them draws an interval or a reference mark as a chart in Markdown.** An interval is a cell or a column (hyperfine, github-action-benchmark, lm-evaluation-harness, Bencher); a threshold is a column (Bencher) or a sentence (github-action-benchmark).
- **GitHub's Mermaid draws neither.** GitHub runs Mermaid 12.3.0 (its viewscreen bundle calls `renderer.draw(e,t,"12.3.0",C)`), and the [xychart syntax](https://mermaid.js.org/syntax/xyChart.html) has bar and line series only, with no error bars and no reference line.
- **A text chart in a code block has one small repo of precedent:** bench-hexo appends an asciichart plot in a `text` block to the job summary ([memory.ts](https://github.com/D-Sketon/bench-hexo/blob/main/src/memory.ts)). asciichart has no interval.

## Decision

1. **Each chart primitive, `Bars`, `Scatter`, `Line` and `Heatmap`, takes a required `table: Table` in its constructor**, and keeps it as `chart.table`. A chart with no table does not compile (Make Illegal States Unrepresentable). The building block that builds the chart writes the table, in its own columns and with the tones of its cells.
2. **`MarkdownRenderer` draws a chart as its table only**, as it draws a `Table` primitive, tones included. It draws nothing of the chart's own numbers.
3. **`HtmlRenderer` draws a chart as one `<figure class="chart">`: the chart, then its table, drawn as a `Table` primitive is drawn.** The folded `<details class="table-view">` that it built from the chart's own numbers goes. The bar rows, the whiskers, the marks, the tooltips and the value labels stay.
4. **`Summary` gives one primitive, its `Bars`, which carries the table** (score, value, interval, bar, verdict). **`Trend` gives one primitive, its `Line`, which carries the table** (run, created, tests, and the value and interval of each score). Their claims do not change.
5. **`TestsMoved` gives each `Scatter` the table of its points** (test, the value in the baseline, the value in the change), in the columns that name the axes; the table of the moved tests stays a primitive of its own.
6. **`barsTable`, `marksTable`, `scatterTable`, `lineTable`, `heatmapTable` and `DataTable` go** from `src/report/data-tables.ts`. `fixed`, `withEnds`, `tones` and `marks` stay.

`Heatmap` has no building block yet. It takes the required table too, by the same rule as every chart.

## Considered Options

- **Markdown skips charts.** The Markdown of a Summary and a Trend would have been the same as now. But no type stops a building block from giving a chart with no table, so a later block that gives only a chart would lose its numbers in Markdown, and no check would see it.
- **A text chart in a code block** (one line for each bar: the label, a block bar such as `█████████░`, the value and the interval; the marks as a line). One small repo is its precedent, and none of the 8 tools draws one. The block bar has no interval and no mark, so the numbers would still need the table beside it, and the Markdown would grow, not shrink.
- **Markdown draws a chart as its own data table (the old form).** Each number of a Summary and a Trend printed twice.

## Consequences

- The Markdown of a page prints each number of a chart once, in the table that the building block wrote. The HTML page shows the table below its chart, always open.
- A new chart primitive takes a required table too, and a building block that gives a chart writes the table that a reader reads in its place.
- A caller that builds a chart without a table gets a type error. No option, alias or fallback keeps the old form.

## Confirmation

The measurement: `measure.ts` (#6244) renders a Summary of an offers-like run (60 tests; recall, precision and empty_pages, with bars of 0.88, 0.88 and 0.95) and a Trend of three such runs through `MarkdownRenderer`. Before: Summary 727 characters, Trend 1046. After: Summary 457, Trend 630.

The tests:

- `src/presentation/primitives.test.ts`: "the type of each chart refuses a chart with no table", four `@ts-expect-error` lines.
- `src/report/markdown-renderer.test.ts`: each chart draws as the table that it carries, tones included, and nothing of its own.
- `src/report/html-renderer.test.ts`: each chart is one figure, the chart then its table as a table is drawn, with no folded table view.
- `src/report/summary.test.ts` and `src/report/trend.test.ts`: the Markdown, parsed back with `mdast-util-from-markdown` and the GFM table extensions, holds one table, a row for each score or run.
- `src/report/tests-moved.test.ts`: each scatter carries the table of its tests, which the Markdown draws in its place.

The mutations (write-test `mutate.mjs`, each one in the memory of its test run or of the TypeScript 7.0.2 checker), all CAUGHT: a `table?` on each of the four charts (4, type mode); Summary gives its `Table` beside its `Bars` again; Markdown draws the bars twice, skips them, or drops the tones of their table; Markdown draws a line twice; Trend's table loses its tests column; Markdown draws a scatter as its own points, or a heatmap as nothing; HTML folds the bars' table in a `table-view` again, puts the scatter's table after its figure, draws the line's table before the chart, or draws the heatmap's table twice; TestsMoved swaps the columns of a scatter's table.
