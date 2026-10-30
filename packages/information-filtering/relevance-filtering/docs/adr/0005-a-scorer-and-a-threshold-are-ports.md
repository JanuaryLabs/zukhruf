# A scorer and a threshold are ports

**Superseded in part by [ADR 0006](./0006-a-scorer-is-made-for-one-interest-and-its-inputs-rule-out-illegal-states.md).** A scorer is now made for one interest with only its own inputs, and `Profile` is removed. The ports, the two adapters and the thresholds of this record are still valid.

Research round 13 (#3383) found a better ranker than the frozen design of [ADR 0002](./0002-the-design-is-frozen-by-research-round-6.md). A decision model, Liquid AI's d1-2B, answered one question for each article and each profile: "Is the main subject of this article: <description>?". Its probability, with no taught answer and no keyword, ranked January to March 2025 with MAP 0.924 against desc+kw's 0.782. Round 14 labelled the same articles again with annotators of a second model family, and the lead held (0.808 against 0.634). The workspace record [docs/research/relevance-filtering.md](../../../../../docs/research/relevance-filtering.md) has the numbers.

Until this record, `profile.train` could rank only by embedding similarity. On 2026-10-30 the user chose ports and adapters: each method of ranking is an adapter of one port, and no method is removed.

## Decision

**A scorer is a port.** `Scorer.score(profile, stream)` gives a `Scores`: the articles of the stream, the best first, each with its probability. The port is asynchronous, because a scorer can call a model.

- **`SimilarityScorer`** is the frozen design of ADR 0002, moved from `profile.train` without a change: the similarity to the description, the binormal model or Platt's method on the answers, and the keyword evidence. It takes the vectors port, a function that gives the vector of a description, and the text of a taught article.
- **`DecisionScorer`** asks a decision model through `experimental_decide` of the AI SDK, so each AI SDK decision provider can be the model. It asks the question of round 13 word for word, as a yes/no question about the text of the article, and the probability of the answer is the score. It uses no keyword and no taught answer: in round 13, the keyword evidence made it worse (MAP 0.876 against 0.924). It asks one profile in each call. A probe of 2026-10-30 found the same probability for one question as for sixteen questions in a call.

**A threshold is a port, apart from the ranking.** `Threshold.cut(scores, profile)` gives the lowest probability that is accepted, and `scores.accepted(threshold)` gives the accepted articles in the order of the ranking. The ranking orders by probability (the probability ranking principle, Robertson 1977). The yes/no decision depends on what the decision costs, and the cost depends on the action: a notification costs more than a mark.

- **`ExpectedFThreshold({ beta })`** maximises the expected F-beta of the stream. With beta 0.5 it is the threshold of the frozen design.
- **`UtilityThreshold({ falseAlarm, miss })`** is the Bayes decision rule: accept when p >= falseAlarm / (falseAlarm + miss) (Lewis, SIGIR 1995). It is correct only for calibrated probabilities.

**The host decides when a scorer runs.** A call to a model can be slow or cost money. The host decides to score on each request, when an article arrives, or from a cache. The package stores nothing.

## Considered Options

- **Remove the similarity design, and keep only the decision model.** Then a host with no decision model has no ranker, and the taught answers and the keywords have no use. The user chose to keep each method as an adapter.
- **A port that reads stored answers of the model.** It puts a decision about time (when to ask the model) in the package. When to call a model is a fact about the host.
- **A fixed cut at 0.5 in the decision scorer.** In round 14, the calibration of d1 changed with the answer key (Brier skill +0.726 on the first key, +0.356 on the second). A threshold that the host chooses, and that research round 15 can adapt to each profile (#3421), is safer than a fixed cut.
- **A cascade of scorers (a cheap scorer shortlists, an expensive scorer ranks the shortlist).** No round tested it. A cascade can be an adapter of the same port later.
- **Keep `profile.train` next to the scorers.** Then the frozen design has two entry points.

## Consequences

- This is a breaking change. `profile.train`, `CalibratedFilter`, `KeywordFilter`, `accepts`, `accepted()` with no argument, `threshold` and `calibration` are removed. A host makes a `SimilarityScorer` and calls `score` where it called `train`.
- `Scores` does not say how a probability was made. A probability from a profile with no relevant answer is 1 for a keyword match and 0 for the others, and it is not calibrated (ADR 0001).
- The eval runs the frozen design through `SimilarityScorer`, and its implementation check and ranking check give the same results as before. The check of the binormal parameters is removed, because the parameters are not published; the check of each probability to 1e-9 stays.
- Research round 15 (#3421) tests a recalibration of the decision model from the taught answers of each profile, before an adapter for it is added.
