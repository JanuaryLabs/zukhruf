# A summary interval bootstraps the statistic of the score, and the verdicts of many scores are corrected with Holm

Status: accepted (Ezz, 2026-11-27, #6108: "Fill both gaps first"). #4234 and #6111 are built before any page, so no page ever shows a wrong interval.

## Context

A score of a run is a ratio of sums over its answers: `Totals`. For a score per item (offers' `values_recall` and `values_precision`), each expected value counts once, so a page with 65 offers weighs 65 times a page with one. For a score per row (`values_f1`), each answer counts once. `Bootstrap` resamples the value of each scorecard, the samples average, so its interval is the interval of a score per item only when each whole is 1 (#4234; found on ipay: 44/45 exact precision gave [12.3%, 21.1%]).

`PairedBootstrap` already resamples tests and recomputes the ratio of sums of each run (ADR 0004, point 3; Koehn 2004). Its p-value is for one name; "the caller corrects" (ADR 0004, point 7). mteb's report applies Holm to its many verdicts, except a primary one that the caller chose before the runs (`packages/mteb/src/report/verdicts.ts`). SOB prints a 95% interval on each metric; Miller 2024 ("Adding error bars to evals") asks for intervals clustered by question.

## Decision

1. **The summary interval of a score resamples tests, with all epochs of each test, and recomputes the ratio of sums of the score.** This is the statistic of `Totals`, so the interval belongs to the number beside it. It needs `Bootstrap` to take the statistic of `Totals` (#4234).
2. **A bar is met when the interval is above it, missed when the interval is below it, and open when the interval holds it.** The claim says which (report ADR 0002).
3. **The verdicts of a pair are corrected together with Holm, except the primary one.** As in mteb's report: a primary score, chosen before the runs, is tested alone. Holm moves to `@zukhruf/statistics` (#6111), and mteb imports it from there.

## Consequences

- Until #4234 ships, the summary shows no interval for a score per item, and says so. It never shows the samples-average interval beside a ratio of sums.
