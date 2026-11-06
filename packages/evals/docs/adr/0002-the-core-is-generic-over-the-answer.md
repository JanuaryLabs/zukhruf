# The core is generic over the answer

Status: Proposed, for review (design on paper, 2026-11-06).

## Context

ADR 0011 of `@zukhruf/structured-eval` (accepted on 2026-11-06) gives the package one comparison core. A `TreeWalk` compares an answer with its case and gives a `Comparison`. A scorer reads the `Comparison` and gives a `Ratio`. `Precision`, `Recall` and `F1` read the counts of a `Matches`, and `Penalized`, `AtLeast`, `ShortfallPenalty`, `SampleAveraged`, `MeanOf` and `ScorerSet` combine scorers. ADR 0012 of `@zukhruf/structured-eval` (accepted on 2026-11-06) made a gate a penalty whose factor is 0 or 1, and `Penalized` replaced `Gated`.

Most of these parts do not depend on a structured value. Only their types name `Comparison`. A classification answer needs the same parts: a recall of one class is hits over expected, and a gate is a gate.

## Decision

The core is generic over the input of its scorers:

- `Scorer<Input>` gives a `Ratio` for one input.
- `Matches<Input>` gives the hits, the stated and the expected of one input. `Precision`, `Recall`, `F1` and `FBeta` take any `Matches`.
- `Penalty`, `Gate`, `Penalized`, `AtLeast`, `ShortfallPenalty`, `SampleAveraged` and `MeanOf` take scorers of one input type.
- A `Comparer<Case, Input>` compares an answer with its case and gives the input. `ScorerSet` and `ScorerAssertion` take a comparer, so they make the input once for each answer.
- A family gives its own input, comparer and matches: `./structured` gives `Comparison`, `TreeWalk`, `PathMatches`, `ValueMatches` and `ItemMatches`; `./classification` gives `LabelComparison`, `LabelComparer`, `ClassMatches` and `AllClassMatches`.

`Ratio`, `Scorecard`, `Totals`, `Bootstrap`, `CaseReader` and `PromptfooAssertion` are already generic, and they move to the core without a change.

## When

The type parameter comes with the second input. Ezz's Rule of Three says, at strike 1: "no generic type for one use". So the move of `./structured` (#3888) keeps `Comparison` as the one input of the core. `./classification` (#3889) brings the second input, and that item adds the type parameter. The session of #3884 agreed to this order on 2026-11-06.

## Considered Options

- **Each family has its own scorers, gates and scorer sets.** The same Decorator and the same Template Method would then live in each family.
- **The core takes `unknown` and each scorer narrows it.** A scorer of labels could then read a structured comparison, and only a run would show the mistake.
- **A type parameter on the core.** This option was selected. A scorer of labels cannot read a structured comparison, and the compiler says so.

## Consequences

- `ScorerAssertion` takes a `comparer` in place of the `spec` of structured-eval's ADR 0011.
- A family has no case of another family. A structured case adds its JSON Schema. A label case has only its labels and its weight.
