# The core is generic over the answer

Status: Accepted 2026-11-07 by Ezz ("Approved, start #3888").

## Context

ADR 0011 of `@zukhruf/structured-eval` (accepted on 2026-11-06) gives the package one comparison core. A `TreeWalk` compares an answer with its case and gives a `Comparison`. A scorer reads the `Comparison` and gives a `Ratio`. `Precision`, `Recall` and `F1` read the counts of a `Matches`, and `Penalized`, `AtLeast`, `ShortfallPenalty`, `SampleAveraged`, `MeanOf` and `ScorerSet` combine scorers. ADR 0012 of `@zukhruf/structured-eval` (accepted on 2026-11-06) made a gate a penalty whose factor is 0 or 1, and `Penalized` replaced `Gated`.

Most of these parts do not depend on a structured value. Only their types name `Comparison`. A classification answer needs the same parts: a recall of one class is hits over expected, and a gate is a gate.

## Decision

The core is generic over the input of its scorers:

- `Scorer<Input>` gives a `Ratio` for one input.
- `Matches<Input>` gives the `Counts` of one input: the hits, the stated and the expected. `Precision`, `Recall`, `F1` and `FBeta` take any `Matches`. `Counts` moves to the core with them.
- `Penalty`, `Gate`, `Penalized`, `AtLeast`, `ShortfallPenalty`, `SampleAveraged` and `MeanOf` take scorers of one input type.
- A `Comparer<Case, Input>` compares an answer with its case and gives the input. `ScorerSet` and `ScorerAssertion` take a comparer, so they make the input once for each answer.
- `Grouped<Input>` is an abstract class of the core: it gives one ratio for each group of an input, under the label `${group} ${label}`. A `ScorerSet` holds a grouped scorer beside plain scorers. Today the `ScorerSet` of structured-eval holds `Scorer | PerField` and tells them apart with `instanceof PerField` (`src/scoring/scorer-set.ts:26, 39`), so the core would import a type of a family. With `Grouped`, it checks `instanceof Grouped`, as it already checks `instanceof Gate`. `PerField` of `./structured` and `PerClass` of `./classification` extend it. Inspect AI's `grouped()` applies a metric to each group of the samples in the same way.
- A family gives its own input, comparer, matches and grouped scorers: `./structured` gives `Comparison`, `TreeWalk`, `PathMatches`, `ValueMatches`, `ItemMatches` and `PerField`; `./classification` gives `LabelComparison`, `LabelComparer`, `ClassMatches`, `AllClassMatches` and `PerClass`.

`Ratio`, `Counts`, `F1Ratio`, `RatioOfSums`, `Scorecard`, `Check`, `ScorecardScorer`, `CaseReader`, `Weighted`, `Totals` and `Bootstrap` import no structured type, and they move to the core without a change. `PromptfooAssertion` imports only these, so it moves to `./promptfoo` without a change. `AssertionModule` names the type `ScorerAssertion` (structured-eval `src/promptfoo/assertion-module.ts:3`), but it reads only `value`, `metric`, `weight` and `threshold`, so it moves to `./promptfoo` with a structural type for those four fields. (Read against structured-eval at mutex 11442c09, 2026-11-07.)

## When

The type parameter comes with the second input. Ezz's Rule of Three says, at strike 1: "no generic type for one use". The core also must not depend on a family: dependencies point toward the stable package (the Stable Dependencies Principle). Both rules hold only in one way. In #3888, the core holds only the parts that are generic today (the list above). Each part that reads a `Comparison` stays in `./structured`: `Scorer`, `Matches`, `Precision`, `Recall`, `F1`, `Penalty`, `Gate`, `Penalized`, `AtLeast`, `ShortfallPenalty`, `SampleAveraged`, `MeanOf`, `ScorerSet`, `PerField` and `ScorerAssertion`. `./classification` (#3889) brings the second input. That item adds the type parameter and moves these parts into the core (and `ScorerAssertion` into `./promptfoo`). The session of #3884 agreed to this order on 2026-11-06.

## Considered Options

- **Each family has its own scorers, gates and scorer sets.** The same Decorator and the same Template Method would then live in each family.
- **The core takes `unknown` and each scorer narrows it.** A scorer of labels could then read a structured comparison, and only a run would show the mistake.
- **A type parameter on the core.** This option was selected. A scorer of labels cannot read a structured comparison, and the compiler says so.

## Consequences

- `ScorerAssertion` takes a `comparer` in place of the `spec` of structured-eval's ADR 0011.
- A family has no case of another family. A structured case adds its JSON Schema. A label case has only its labels and its weight.
