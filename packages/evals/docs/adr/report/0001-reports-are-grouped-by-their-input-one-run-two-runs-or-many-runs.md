# Reports are grouped by their input: one run, two runs or many runs

Status: accepted (Ezz, 2026-11-27, #6108: "By input"). The names wait for the review of the paper.

## Context

Ezz chose ten kinds of view for evals of structured answers (docs/report.md, "The kinds of report"). Each kind reads one run, two runs on the same tests, or many runs. When a view can be written depends on that input, not on the view: a summary can be written when its run ends, a verdict only when both runs exist. Ezz: "it depends on the reporter".

Two groupings were on the table:

- **One reporter for each kind**, as BenchmarkDotNet has one exporter for each format.
- **One report for each input, with a section for each kind**, as `@zukhruf/mteb/report` puts the results of one task on one page, Braintrust shows one experiment or one comparison in one view, and Go's benchstat prints one table for the files it reads.

## Decision

1. **Three reports: `RunReport` (one run), `PairReport` (two runs on the same tests) and `TrendReport` (many runs).** Each one is built with `from(…)` and gives `toHtml()` and `toMarkdown()`, as mteb's `Report` does.
2. **Each kind is a section of the report of its input.** The field diff is a section of both `RunReport` (each answer beside its case) and `PairReport` (the two answers beside the case).
3. **The input sets when a report can be written, and the host writes it.** `RunReport` at the end of a run (promptfoo's `afterAll`); `PairReport` when both runs exist; `TrendReport` when asked. The package has no trigger of its own.

## Consequences

- A host that wants one section only builds the report with that section's options; there is no reporter class per kind.
- A comparison of more than two runs side by side is a later report.
