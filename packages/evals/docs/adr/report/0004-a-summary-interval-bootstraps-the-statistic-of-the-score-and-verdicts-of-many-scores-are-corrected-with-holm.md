# A summary interval bootstraps the statistic of the score, and the verdicts of many scores are corrected with Holm

Status: accepted (Ezz, 2026-11-27, #6108: "Fill both gaps first"). #4234 and #6111 are built before any page, so no page ever shows a wrong interval.

Status, 2026-11-27 (#6108): `Summary` is built. Its value is `Run#total` and its interval `Bootstrap.interval` on the same run, or on the run of a slice's samples for a bar with a slice. A bar is met, missed or open as point 2 says, and a row with no value reads untested: a slice with no samples or with no sample that gives the score, or a score with no whole, such as recall on pages with no expected value (`Ratio.value` gives 0 there for SOB's scores, and a page would read that 0 as a score). Holm (point 3) belongs to `Verdicts`, which is not built yet.

Status, 2026-11-28 (#6108): `Verdicts` is built. Each score's verdict is `PairedBootstrap.verdict` on the two runs, in the order of the scores; the primary score is decided by its own p and the others by their Holm-adjusted p, below 0.05, as mteb's report does (point 3; the copy is in docs/copied-code.md, backlog #6288).

Status, 2026-11-28 (#6267, 75c239dc): a bootstrap resample whose statistic has no value is left out (Ezz's rule B, core ADR 0010), so an interval comes from the resamples that have a value and its table says "from K of N resamples" when K < N, and a p of `PairedBootstrap` is a share of the kept resamples. A score that no resample of the pair tests has the verdict untested, with no difference and no p: `Verdicts` shows it as untested and leaves it out of the Holm family, which corrects only the scores that have a p (core ADR 0004).

## Context

A score of a run is a ratio of sums over its answers: `Totals`. For a score per item (offers' `values_recall` and `values_precision`), each expected value counts once, so a page with 65 offers weighs 65 times a page with one. For a score per row (`values_f1`), each answer counts once. `Bootstrap` resamples the value of each scorecard, the samples average, so its interval is the interval of a score per item only when each whole is 1 (#4234; found on ipay: 44/45 exact precision gave [12.3%, 21.1%]).

`PairedBootstrap` already resamples tests and recomputes the ratio of sums of each run (ADR 0004, point 3; Koehn 2004). Its p-value is for one name; "the caller corrects" (ADR 0004, point 7). mteb's report applies Holm to its many verdicts, except a primary one that the caller chose before the runs (`packages/mteb/src/report/verdicts.ts`). SOB prints a 95% interval on each metric; Miller 2024 ("Adding error bars to evals") asks for intervals clustered by question.

## Decision

1. **The summary interval of a score resamples tests, with all epochs of each test, and recomputes the ratio of sums of the score.** This is the statistic of `Totals`, so the interval belongs to the number beside it. It needs `Bootstrap` to take the statistic of `Totals` (#4234).
2. **A bar is met when the interval is above it, missed when the interval is below it, and open when the interval holds it.** The claim says which (report ADR 0002).
3. **The verdicts of a pair are corrected together with Holm, except the primary one.** As in mteb's report: a primary score, chosen before the runs, is tested alone. Holm moves to `@zukhruf/statistics` (#6111), and mteb imports it from there.

## Consequences

- Until #4234 ships, the summary shows no interval for a score per item, and says so. It never shows the samples-average interval beside a ratio of sums.
