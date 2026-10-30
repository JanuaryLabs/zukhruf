# The reader ranks, and does not decide yes or no

**Superseded in part by [ADR 0005](./0005-a-scorer-and-a-threshold-are-ports.md).** The ranking of this record is still valid, and `scores.ranked({ from, to })` gives it. The yes/no API is now a threshold port: `scores.accepted(threshold)`, with an expected-F threshold or an expected-utility threshold that the host chooses.

Research round 9 (#3195) tested the yes/no designs on a slice of the feed that no round had seen: July to September 2025. Every design failed, the frozen design of [ADR 0002](./0002-the-design-is-frozen-by-research-round-6.md) too. The ranking of the articles was strong. The weak part was the threshold, which a few taught answers must set. The workspace record [docs/research/relevance-filtering.md](../../../../../docs/research/relevance-filtering.md) has the numbers.

On 2026-10-29 the user chose a ranked reader: each interest shows its best N articles a day, the best first. The person sets N. The keywords count as evidence. There is no yes/no threshold. TREC calls this task routing, and scores it by mean average precision (MAP) (Harman, TREC 1993 to 1998).

Round 10 then compared three rankers with keyword lists on the same slice, in two teaching protocols. It chose `desc+kw`, and froze it with its exam rule in `freeze-ranking/plan.json` (sha256 `c43a44d0…`, 2026-10-29T12:35:16Z):

| Protocol                                                         | desc+kw MAP | keywordNarrow | keywordBroad | Newest first |
| ---------------------------------------------------------------- | ----------- | ------------- | ------------ | ------------ |
| Window: teach from the first 14 days, rank the rest              | 0.717       | 0.514         | 0.486        | 0.065        |
| Pool: teach from the three earlier slices, rank all of the slice | 0.766       | 0.476         | 0.462        | 0.055        |

## Decision

**Each filter ranks its stream.** `filter.ranked()` gives the ids of the stream, the best first. `filter.ranked({ from, to })` gives only the articles published in that range, in the same order, with the two edges in the range. The best N of a day are `filter.ranked({ from, to }).slice(0, n)` for the bounds of the day. The host chooses the bounds, because the day of a reader depends on the time zone of the reader. The order is that of the whole stream, because the binormal model is fitted on the whole stream.

- **A `CalibratedFilter` ranks by the probability of the frozen design**, then by the similarity to the description, then by id. Equal probabilities occur when the probability is 1 to the last bit.
- **A `KeywordFilter` ranks the keyword matches first, the newest first**, then the other articles by similarity. Equal dates and equal similarities sort by id. The ids compare by code unit, not by locale.

**The yes/no API stays, and is not recommended.** `accepts`, `accepted` and `threshold` are published, so they stay. The documentation says that they are not recommended for decisions, after rounds 9 and 10. A change to them needs the user's consent.

## Considered Options

- **`top(n)`, a method that takes N.** `ranked().slice(0, n)` says the same with the array of the platform, and the person can change N without a new call to train.
- **`rankedOn(day)`, with a day.** A day needs a time zone, and the package does not know the time zone of the reader. A publish range does not need one.
- **A score for each article in place of an order.** The order needs two tie rules (similarity, then id), which a caller would have to know. The order gives them.
- **Remove the yes/no API.** It is published surface. The user did not ask to remove it.

## Consequences

- A host shows `ranked({ from, to }).slice(0, n)` for each interest and each day.
- The eval scores `ranked()` by MAP (`nx run relevance-filtering:eval -- ranking`), and the ranking check compares the order of one unit with the order of the research code.
- The exam of `freeze-ranking/plan.json` scores the ranking, not the yes/no decisions.
- `freeze-ranking/plan.json` says "newest first" for the matches of a profile with no relevant answer. The research code of round 10 orders those matches by similarity. No scored unit of round 10 had a profile with no relevant answer, so its numbers do not change. The package follows the plan.
