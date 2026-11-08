# Copied code

This package keeps three copies of the knowledge of `@zukhruf/mteb`. Each copy is in its second place, so it stays a copy (Rule of Three, [ADR 0004](adr/0004-two-runs-are-compared-by-a-paired-bootstrap-over-their-tests.md)). A third place starts the extraction (backlog #4009). The three working copies then give the boundary of the shared code. Until then, make each fix in both copies, and name both files in the commit.

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
