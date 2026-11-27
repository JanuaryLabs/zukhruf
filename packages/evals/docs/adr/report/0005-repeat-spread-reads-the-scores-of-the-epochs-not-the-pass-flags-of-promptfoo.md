# Repeat spread reads the scores of the epochs, not the pass flags of promptfoo

Status: proposed (2026-11-27, #6108). Design for review: no code yet.

## Context

promptfoo writes `repeatStability` beside a run with `--repeat`: a group of repeats is unstable when some repeats pass and some fail. An eval that sets each threshold to 0, as offers does so that no bar lives in promptfoo, passes every row. On eval-ove of offers-evals (DeepSeek, 307 pages, 3 epochs each) promptfoo reports 0 unstable groups, while the `values_f1` of the three answers differs on 66 of the 307 pages, such as 0, 1 and 0.40 on `cohorts.clay.com/wedge` and 1, 0 and 0 on `nlnet.nl/commonsfund` (read 2026-11-27). Inspect AI shows the scores of each epoch of a sample; Braintrust groups the rows of one input; Kleister reports ± SD over 3 runs.

## Decision

1. **The spread of a test on a score is the range of the score over its epochs**, with each epoch's own ratio. A test with one epoch has no spread.
2. **The section lists the tests whose spread is not 0, widest first**, with the score of each epoch, and gives the share of tests that are not stable for each score.
3. **The report never reads `repeatStability`.**

## Consequences

- A run with one epoch per test has no repeat spread section; the page says that the run has no repeats.
