# A scorer is made for one interest, and its inputs rule out illegal states

[ADR 0005](./0005-a-scorer-and-a-threshold-are-ports.md) made ranking a port with two adapters, but each scorer still took the `Profile` of [ADR 0001](./0001-a-profile-is-a-value-and-train-decides-on-one-stream.md): a name, a description, optional keywords, and the yes and no answers. Only the similarity design reads the keywords and the answers. A caller of the decision scorer had to give `relevant: []` and `notRelevant: []` that nothing read, and the types let four states through that the code had to reject at run time: one article as a yes and a no answer (`ConflictingAnswerError`), no yes answer and no keyword (`NoEvidenceError`), one id two times in a stream (`RangeError`), and an empty stream (a non-empty tuple that each host had to unpack). On 2026-10-30 the user said that this API does not make illegal states unrepresentable, and that keeping the old shape is backward compatibility, which this project does not allow.

## Decision

**A scorer is made for one interest, with only the inputs of its method.** The port is `Scorer.score(stream)`. The host makes one scorer for each interest.

- `new DecisionScorer({ model, description })`: the decision model and the sentence. Nothing else exists on it.
- `new SimilarityScorer({ vectors, descriptionVector, answers, keywords })`: the frozen design of ADR 0002 for an interest with at least one yes answer. `answers` is a `TaughtAnswers`.
- `new KeywordScorer({ vectors, descriptionVector, keywords })`: the cold start of the frozen design, for an interest with no yes answer yet. `keywords` is a non-empty tuple.

**Parse, do not validate (Alexis King, 2019).** `TaughtAnswers.parse(answers)` takes the answers as a map by article id, each with its text, and gives `undefined` when no answer is a yes. A map holds one answer for each article, so an article cannot be a yes and a no. A `SimilarityScorer` cannot be made without a yes. The text of each answer is next to its answer, in place of a `taughtText` callback.

**A stream is a map by id.** One entry for each id, so no id repeats. An empty stream is legal and gives empty `Scores`; a scorer reads no vector and asks no model for it.

**The description vector is an input, not a callback.** A scorer is made for one interest, so the host embeds the description once, with the prompt of its model, and gives the vector.

**`Threshold.cut(scores)` takes no profile.** No threshold read it. `Scores` is made from a map in the order of the scorer, and keeps no profile.

**One case stays a decision of the data.** When the binormal fit cannot hold and no answer is a no, Platt's method has nothing to fit. The similarity scorer then ranks the keyword matches first and the other articles by similarity, with no error, also when there is no keyword. No research round reached this case.

## Considered Options

- **One `Profile` for every scorer, with optional teaching.** The optional fields are filler for the decision scorer, and a missing yes answer is a run-time error.
- **`TaughtInterest extends Interest`, and a generic port.** A taught interest is also an interest, so a decision scorer would accept it and ignore its answers without a sign.
- **Teaching in a callback of the similarity scorer.** The answers move away from the interest that they belong to.

## Consequences

- This is a breaking change (0.6.0). `Profile`, `ProfileFields`, `profile.with`, `ConflictingAnswerError`, `NoEvidenceError`, the `embedDescription` and `taughtText` callbacks, the profile argument of `Threshold.cut`, the `id` of `Article` (it is the key of the stream) and the non-empty stream tuple are removed.
- A host keeps its interests and answers itself, and makes the scorer that the state of an interest allows: `DecisionScorer` with a decision model; else `SimilarityScorer` when `TaughtAnswers.parse` gives answers, and `KeywordScorer` when it does not.
- `src/api.test.ts` holds the illegal inputs as `@ts-expect-error` lines, so the type check fails if one of them becomes legal.
- The eval runs the frozen design through `SimilarityScorer`, and through `KeywordScorer` for a unit with no yes answer. Its implementation check and ranking check give the same results as before.
