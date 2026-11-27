# Each section title is a claim that its numbers give

Status: proposed (2026-11-27, #6108). Design for review: no code yet.

## Context

`@zukhruf/mteb/report` writes each section title as a claim that comes from the numbers below it, and Ezz approved that page (#3471). A title such as "Scores" makes the reader find the answer; a title such as "DeepSeek is better than Haiku on values_recall" gives it, and the chart below shows why. Braintrust grades a comparison (improvement, regression, trade-off, tie) for the same reason.

## Decision

1. **The report computes each title from the numbers of its section.** A new run with other numbers gives other titles.
2. **A claim never says more than its numbers.** An inconclusive verdict reads "No difference beyond chance on values_recall (+4.6 [−0.6, +12.7])", never "better". A summary under its bar reads the bar it misses, with the interval.
3. **The family writes the claims of its own sections**, in its own words, from its own numbers (core ADR 0008).

## Consequences

- The tests of a section assert its claim for each case of its numbers (above, across and below a bar; better, worse and inconclusive).
