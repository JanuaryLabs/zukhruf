# Copied code

This package keeps copies of the knowledge of `@zukhruf/mteb`: three of its paired bootstrap, the shell of its report page (a section that has its own end), and the verdicts of its report (a section that has its own backlog item). It also keeps one copy of its own: the leaf classes of `FieldErrors` in `FieldDiff` (the last section, which has its own backlog item). Each copy of the paired bootstrap is in its second place, so it stays a copy (Rule of Three, [ADR 0004](adr/0004-two-runs-are-compared-by-a-paired-bootstrap-over-their-tests.md)). A third place starts the extraction (backlog #4009). The three working copies then give the boundary of the shared code. Until then, make each fix in both copies, and name both files in the commit.

## From the paired bootstrap test of mteb

`PairedBootstrap` of this package (`src/scoring/paired-bootstrap.ts`) compares two runs on the same tests. mteb's `pairedBootstrapTest` (`packages/mteb/src/significance/paired-bootstrap.ts`) compares the scores of a change and its baseline, query by query. The two do the same work on other inputs, so three parts are copies.

**The pairing: `pairedBootstrapTest` (the `unpaired` check) → `PairedBootstrap.#pairs`.**
Both pair two sets by key, and both refuse a key that one set does not have, with a `RangeError` that names each such key: first the keys of the baseline, then the keys of the change.
Changes: the key is a test id, not a query. The pairs follow the order of the first adds of the baseline run, not the sorted keys, because each resample takes its random indices in the order of the pairs. A test also has a weight, so a test whose weight is not the same in the two runs is a `RangeError` too. mteb has no weights.

**The verdict: better when the interval is above 0, worse when it is below 0, inconclusive else → `PairedBootstrap.#result`.**
Both read the side of 0 with `isAbove` and `isBelow` of `ConfidenceInterval`.
Changes: the caller gives `higherIsBetter`. With `false`, better and worse change places. mteb always reads a higher score as better.

**The p-value: `min(1, 2 · min(share ≤ 0, share ≥ 0))` → `PairedBootstrap.#p`.**
Both take the same shares of the same resample differences.
Changes: none.

### Not copied

These parts are not copies: the statistic (mteb takes the mean of the differences; `PairedBootstrap` takes the ratio of sums of each run, with each weight), the epochs, and the counts of the tests. `IidBootstrap`, `PercentileInterval` and `DifferenceInterval` are of `@zukhruf/statistics`, so both use them and neither copies them. event-detection's `changeOfMainScore` drops a key that one set does not have, so it has another rule and does not count as a place.

## From the report page of mteb

The HTML page of `./report` starts as a copy of the shell of `@zukhruf/mteb/report` ([report ADR 0003](adr/report/0003-a-page-is-html-or-markdown-text-in-the-base-layer.md)). These copies end when mteb's report becomes `./ranking` building blocks on a `Page` (#6112): mteb then draws with `HtmlRenderer`, and its own copies go. Until then, make each fix in both copies, and name both files in the commit.

**The styles: `packages/mteb/src/report/styles.ts` → `src/report/styles.ts`.**
Both have the same tokens of the light and dark themes (`prefers-color-scheme` with the `[data-theme]` guard), the 64rem column, the section and claim heading, the bar grid, the plot with its gridlines and hair, the heatmap cell as a `color-mix` of `--heat-lo` and `--heat-hi`, the folded table view, the table, the tooltip, and the narrow-screen and reduced-motion rules.
Changes: the role colours of mteb (best, baseline, other) and its verdict colours give way to the eight categorical slots of the dataviz palette (`--s0` to `--s7`, light and dark, set by `data-series`), since a line has any number of series; the dark tokens are one string that both dark scopes take, not two copies. The parts of mteb's sections that no primitive draws (hero, tiles, forest, split switch, method, footer) are left out; the scroll boxes of tables and heatmaps are positioned, so the visually hidden word of a toned cell (`.sr`, which mteb does not have) stays inside its box and does not widen a phone page; the parts that only primitives draw are new: the whisker, the labelled mark rule (one label row per mark, anchored so that it stays in its row), the scatter point and diagonal, the interval band of a line, the value pairs, the tone icon.

**The tooltip script: `packages/mteb/src/report/script.ts` → `src/report/script.ts`.**
Both show one tooltip for each element with `data-tip`, put its text in with `textContent`, and show it on keyboard focus as on hover.
Changes: the key of a row is a series slot (`data-series`), not a role. The split switch is left out, since a page has no splits.

**The escape and the number formats: `esc`, `known` with `fixed`, the `tip` attribute and the `at` percent of `packages/mteb/src/report/page.ts` → `esc`, `tip` and `percent` of `src/report/html-renderer.ts`, and `fixed` of `src/report/data-tables.ts`.**
Both escape `&`, `<`, `>`, `"` and `'` as numeric entities, show a missing number as a dash and a number with three decimals, and put a tooltip in a `data-tip` attribute as escaped JSON.
Changes: `percent` also clamps the position to 0–100%, since a primitive can hold a value outside its scale. `fixed` is shared with the Markdown renderer.

**The page shell: the end of `page` in `packages/mteb/src/report/page.ts` → `HtmlRenderer.render`.**
Both give a page with no `<html>`, `<head>` or `<body>`: the charset, the title, the viewport meta of claude.ai, the IBM Plex fonts of Google Fonts, the styles, a `main`, the tooltip element and the script.
Changes: the page heading is the title of the `Page`, and each section is a claim and its primitives; no footer.

## The verdicts of mteb's report

`Verdicts` of `./report` (`src/report/verdicts.ts`) decides the verdicts of many scores of a run pair as mteb's `verdicts` (`packages/mteb/src/report/verdicts.ts`) decides those of many comparisons ([report ADR 0004](adr/report/0004-a-summary-interval-bootstraps-the-statistic-of-the-score-and-verdicts-of-many-scores-are-corrected-with-holm.md), point 3). The rule is in its second place, so it stays a copy (Rule of Three); `./report` does not depend on `@zukhruf/mteb`. A third place starts the extraction (backlog #6288); the three working copies then give its boundary. Until then, make each fix in both copies, and name both files in the commit.

**The family: the primary comparison alone, Holm over the others → the primary score alone, Holm over the other scores.**
Both test the one that was chosen before the runs alone, adjust the p-values of all the others together with `Holm` of `@zukhruf/statistics`, and decide each one by its deciding p-value: p for the primary one, the Holm-adjusted p for the others.
Changes: the family is the scores of one pair, not each pair of models on each score, so the primary is a score's name and must be one of the scores (a `RangeError` otherwise); mteb's primary is optional. The primary row comes first.

**The decision: `ALPHA = 0.05` and `decide` → `ALPHA` and `decide`.**
Both count a deciding p-value below 0.05, and read better or worse from the sign of the observed difference.
Changes: the sign is read in the direction of the score (`higherIsBetter`), since a score of this package can be better lower; mteb always reads a higher score as better. The result that is not beyond chance reads "no difference", not "inconclusive", the word of report ADR 0002's claims.

### Not copied

The verdict of each score is `PairedBootstrap.verdict` (its own copy of mteb's `pairedBootstrapTest`, above), and `Holm` is of `@zukhruf/statistics`, so neither is copied here. The per-query scores of mteb's predictions are mteb's own.

## The leaf classes of FieldErrors

`FieldDiff` of `./structured` (`src/structured/report/field-diff.ts`) marks each leaf by the class that `FieldErrors` (`src/structured/report/field-errors.ts`) counts ([structured ADR 0014](adr/structured/0014-field-errors-have-five-classes-and-the-field-diff-pairs-items-as-the-scorer-pairs-them.md), points 2 and 5). The rule is in its second place, so it stays a copy (Rule of Three). A third place starts the extraction (backlog #6277); the three working copies then give its boundary. Until then, make each fix in both copies, and name both files in the commit.

**The leaf class: `FieldErrors.#leafClass` → `FieldDiff.#pair` and `FieldDiff.#leafClass`.**
Both class a leaf the same way: spurious when only the answer has it, missed when only the expected side has it, correct when the comparator of its field agrees, partial when the two sides disagree and share a word (`BagOfWords.of(...).shared(...).hits > 0`), and incorrect when they share none.
Changes: `FieldDiff.#pair` sorts out the leaves of one side, since their marks (`only-expected`, `only-actual`) hold the side, not a class, and `FieldDiff.#leafClass` takes a leaf with both sides (`BothSides`) and gives correct, partial or incorrect, the classes that have a mark of both sides (`agree`, `near`, `disagree`). So a pair of one side cannot have the mark of two sides.

### Not copied

The item classes of `FieldErrors` (`#itemClass`, `#isUnder`) are not copied: `FieldDiff` shows leaves, and a leaf of an unpaired item is on its own side by its own class. The leaf options (`nullIsMissing`) and the comparison (`Comparer#compare`, `Comparison#leaves`) are the parts both call, so neither copies them.

## Copies in test files

**A sample of a structured answer against its case (test data).**

- Places: `src/structured/report/field-diff.test.ts` and `src/structured/report/field-errors.test.ts`.
- Same: the `answered` sample of a real `Case` with an answer, and the run info.
- A third place moves it into a test fixture of `./structured`.

**The render test of a building block.**

- Places: `src/structured/report/field-diff.test.ts`, `src/structured/report/field-errors.test.ts` and `src/report/repeat-spread.test.ts`, as copy-check finds them; each block's test file has one (backlog item of this copy).
- Same: the section on a `Page` through `HtmlRenderer` and `MarkdownRenderer`, its claim in each, and no `NaN`.
- Differs: the section and its claim.
