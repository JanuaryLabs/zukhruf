# Copied code

This package keeps copies of the knowledge of `@zukhruf/mteb`: three of its paired bootstrap, and the shell of its report page (the last section, which has its own end). Each copy of the paired bootstrap is in its second place, so it stays a copy (Rule of Three, [ADR 0004](adr/0004-two-runs-are-compared-by-a-paired-bootstrap-over-their-tests.md)). A third place starts the extraction (backlog #4009). The three working copies then give the boundary of the shared code. Until then, make each fix in both copies, and name both files in the commit.

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
Changes: the role colours of mteb (best, baseline, other) and its verdict colours give way to the eight categorical slots of the dataviz palette (`--s0` to `--s7`, light and dark, set by `data-series`), since a line has any number of series; the dark tokens are one string that both dark scopes take, not two copies. The parts of mteb's sections that no primitive draws (hero, tiles, forest, split switch, method, footer) are left out; the parts that only primitives draw are new: the whisker, the labelled mark rule, the scatter point and diagonal, the interval band of a line, the value pairs, the tone icon.

**The tooltip script: `packages/mteb/src/report/script.ts` → `src/report/script.ts`.**
Both show one tooltip for each element with `data-tip`, put its text in with `textContent`, and show it on keyboard focus as on hover.
Changes: the key of a row is a series slot (`data-series`), not a role. The split switch is left out, since a page has no splits.

**The escape and the number formats: `esc`, `known` with `fixed`, the `tip` attribute and the `at` percent of `packages/mteb/src/report/page.ts` → `esc`, `tip` and `percent` of `src/report/html-renderer.ts`, and `fixed` of `src/report/data-tables.ts`.**
Both escape `&`, `<`, `>`, `"` and `'` as numeric entities, show a missing number as a dash and a number with three decimals, and put a tooltip in a `data-tip` attribute as escaped JSON.
Changes: `percent` also clamps the position to 0–100%, since a primitive can hold a value outside its scale. `fixed` is shared with the Markdown renderer.

**The page shell: the end of `page` in `packages/mteb/src/report/page.ts` → `HtmlRenderer.render`.**
Both give a page with no `<html>`, `<head>` or `<body>`: the charset, the title, the viewport meta of claude.ai, the IBM Plex fonts of Google Fonts, the styles, a `main`, the tooltip element and the script.
Changes: the page heading is the title of the `Page`, and each section is a claim and its primitives; no footer.
