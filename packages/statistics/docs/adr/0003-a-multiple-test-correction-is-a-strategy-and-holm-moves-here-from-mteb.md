# A multiple-test correction is a Strategy, and Holm moves here from mteb

Status: accepted (2026-11-27, #6111). Ezz chose the shape ("Strategy class").

`@zukhruf/mteb` had the one Holm correction of the workspace, `holm(pValues)` in `src/significance/holm.ts`, which its report applies to the verdicts of many comparisons (`src/report/verdicts.ts`). `@zukhruf/evals` gives each verdict a p-value and leaves the correction to its caller (its ADR 0004, point 7), and the reports of `@zukhruf/evals` (#6108) test many scores of two runs at once, so they need the correction too. A correction of p-values is statistics, not retrieval, so its home is this package. `@zukhruf/evals` and `@zukhruf/mteb` both depend on it already. The code moves; it is imported, not copied, so this is a question of its home and not of the Rule of Three.

statsmodels gives the corrections through one function, `multipletests(pvals, alpha, method)` of `statsmodels.stats.multitest`, with methods such as `holm`, `bonferroni` and `fdr_bh`. R gives them through `p.adjust(p, method)`. This package names each rule of a family as a class of one interface, as `ConfidenceIntervalMethod` and `PercentileInterval` name the method of `scipy.stats.bootstrap`.

## Decision

1. **`MultipleTestCorrection` is the interface of a correction**: `adjust(pValues)` gives the adjusted p-values, in the order of the p-values (Strategy). The verb is R's `p.adjust`.
2. **`Holm` is the first correction**: the step-down rule of Holm 1979, with the values of statsmodels 0.15.0 `multipletests(p, method="holm")[1]` to the last bit. Its code is mteb's `holm`, unchanged.
3. **Its golden test moves with it.** `src/fixtures/holm/generate.py` writes the 7 cases of mteb's fixture with statsmodels 0.15.0; the regenerated values were the same as mteb's. The p-values are literals now, since mteb's generator drew some of them from its own random generator and from its bootstrap verdicts.
4. **mteb imports `Holm`** in `verdicts.ts` and in its report test. Its `holm`, the export of `holm` from `@zukhruf/mteb`, the Holm cases of its fixture and statsmodels in its generator go. mteb's generator, run again, gave the same bm25, synthetic and percentile values.

## Consequences

- A caller of `holm` from `@zukhruf/mteb` writes `new Holm().adjust(p)` from `@zukhruf/statistics`. No caller outside mteb used it (search of 2026-11-27 in zukhruf, offers-evals, context-compiler and datahub).
- Bonferroni or Benjamini–Hochberg are one more class each when a caller needs one.
