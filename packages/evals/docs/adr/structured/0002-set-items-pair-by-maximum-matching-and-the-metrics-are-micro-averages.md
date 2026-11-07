# Set items pair by maximum matching, and the metrics are micro averages

Status: amended by [ADR 0011](0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md) (accepted 2026-11-06). Maximum matching becomes the alignment `ByBestMatch`, and the micro average is what a plain scorer gives. SOB numbers come from `ByPosition` and `SampleAveraged` in SOB's caller, not from a separate port.

The items of a set array have no order. A harness can state the same offers in a different order, or state one more. A pair by position then compares the wrong items, and every later item is wrong.

The package pairs set items by maximum matching: of all possible pairings, it takes the one with the most agreeing fields (the Hungarian algorithm, `munkres`). A match rule can forbid a pair, such as two offers whose quotes are different sentences. An item with no pair counts as a stated or an expected item only. Then each field of each pair goes through its comparator.

The metrics are micro averages: the counts of all records add together before the division. A record with ten offers thus weighs ten times a record with one.

Precedents: DocILE line-item recognition ("maximum matching which maximizes the total number of matched fields", "micro F1 over all line item fields"); AWS Stickler (Hungarian list matching "regardless of order", a comparator for each field type); ExtractBench (a metric for each field; an invalid record still counts).

## Considered Options

- Pair by position (OpenAI evals json_match, autoevals JSONDiff). An ordered array still does this.
- Pair greedily, in the order of the stated items.
- Maximum matching. This option was selected.

## Consequences

- Scores are not comparable with benchmarks that pair by position, such as SOB. For SOB numbers, use SOB parity (ADR 0003).
- In promptfoo, each metric is a ratio with its denominator as the weight (`namedScoreWeights`), so the column header shows the micro average.
