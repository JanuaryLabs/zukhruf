# Repeat spread reads the scores of the epochs, not the pass flags of promptfoo

Status: proposed (2026-11-27, #6108). Design for review: no code yet.

Status, 2026-11-27 (#6108): `RepeatSpread` is built in `src/report/repeat-spread.ts`. Its first table gives, for each score, the tests with two epochs or more with a value, those whose spread is not 0, and their share; its second lists the unstable tests widest first, at most `widest` rows, a limit that the host sets (report ADR 0003), and is a note when no test is unstable. An epoch whose sample does not give the score, or gives it a ratio of no whole, has no value and is left out of the spread (`Ratio.value` gives 0 there for SOB's scores, and a page would read that 0 as a score); a test with fewer than two epochs with a value has no spread. The claim reads the first score. Bars are not read.

## Context

promptfoo writes `repeatStability` beside a run with `--repeat`: a group of repeats is unstable when some repeats pass and some fail. An eval that sets each threshold to 0, as offers does so that no bar lives in promptfoo, passes every row. On eval-ove of offers-evals (DeepSeek, 307 pages, 3 epochs each) promptfoo reports 0 unstable groups, while the `values_f1` of the three answers differs on 66 of the 307 pages, such as 0, 1 and 0.40 on `cohorts.clay.com/wedge` and 1, 0 and 0 on `nlnet.nl/commonsfund` (read 2026-11-27). Inspect AI shows the scores of each epoch of a sample; Braintrust groups the rows of one input; Kleister reports ± SD over 3 runs.

## Decision

1. **The spread of a test on a score is the range of the score over its epochs**, with each epoch's own ratio. A test with one epoch has no spread.
2. **The section lists the tests whose spread is not 0, widest first**, with the score of each epoch, and gives the share of tests that are not stable for each score.
3. **The report never reads `repeatStability`.**

## Consequences

- A run with one epoch per test has no repeat spread section; the page says that the run has no repeats.
