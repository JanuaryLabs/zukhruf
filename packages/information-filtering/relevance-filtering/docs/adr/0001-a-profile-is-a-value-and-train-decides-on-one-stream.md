# A profile is a value, and train decides on one stream

The shape of the API was agreed in #3195: `new Profile({ name, description, keywords?, relevant, notRelevant })` makes an immutable value with no I/O, `profile.with({...})` gives a corrected copy, and `profile.train(...)` gives a classifier with `probability(id)` and the expected-F0.5 decision. This record says what `train` takes and gives, because the frozen design ([ADR 0002](./0002-the-design-is-frozen-by-research-round-6.md)) needs facts that the agreed shape did not name.

## What train needs

| Fact                                                                | Why the design needs it                                                                    | Who knows it                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| The vector of the description                                       | The score of an article is the cosine of its vector and the description vector.            | The caller: it has the model and the prompt of the model for a query.       |
| The vectors of the stream and of the taught articles                | The calibration compares the taught scores with the scores of the stream.                  | The store of the host, for example a `Collection` of `@zukhruf/embeddings`. |
| The stream                                                          | The binormal model is fitted on the scores of the articles that the filter decides on.     | The host.                                                                   |
| The text of each stream article and of each taught relevant article | The keyword evidence counts the matches in the stream and in the taught relevant articles. | The host.                                                                   |

## Decision

```ts
profile.train({
  vectors, // { query(vector, { from, to }), fetch(ids) }
  descriptionVector, // readonly number[]
  stream, // readonly [Article, ...Article[]], Article = { id, publishedAt, text }
  taughtText, // (id) => string
}): CalibratedFilter | KeywordFilter
```

- **The vectors are a port.** `Vectors` has the two calls of a `Collection` that the filter needs. The package does not import `@zukhruf/embeddings`: a domain package does not import another domain package in its shipped code (workspace ADR 0001, rule 5). Event grouping has a port for the same reason. The scores of the stream come from one `query` over the publish dates of the stream. The taught scores come from `fetch` and one dot product, because the taught articles can be from any date. A stream article that the query does not give is a `MissingVectorError`.
- **The package does not embed the description.** The text of a query needs the prompt of its model (`task: search result | query: …` for EmbeddingGemma), and the package must not name a model. The eval gives the vectors of the research.
- **The stream is a list of articles, not a date range.** The exam teaches from articles of the same dates as its stream, in other collections. A list of ids lets the host decide on any set. `publishedAt` gives the query range. The type is a non-empty tuple: a binormal fit on no score has no meaning.
- **The text of a taught article comes from a function.** The profile holds ids only, because the texts are data of the host. The filter calls `taughtText` only for the taught relevant articles, and only when the profile has keywords.
- **Two kinds of filter.** A profile with no relevant answer cannot calibrate a score. It accepts the keyword matches, as the frozen design says (`noRelevantExample`). Thus `train` gives a `KeywordFilter` (`kind: 'keywords'`, probability 1 or 0, no threshold and no calibration) or a `CalibratedFilter` (`kind: 'calibrated'`, with its `calibration` and `threshold`). A caller can tell a calibrated probability from a keyword match by the type.
- **No keyword filter without keywords.** A profile with no relevant answer and no keyword has nothing to decide with. `train` throws `NoEvidenceError`, and does not give a filter that accepts nothing.
- **One answer for each article.** An id in `relevant` and in `notRelevant` is a `ConflictingAnswerError` in the constructor, and thus in `with`.
- **A filter belongs to its stream.** `probability` and `accepts` of an id that is not in the stream are an `UnknownArticleError`. To decide on new articles, train again with the new stream.

## Considered Options

- **The profile stores the description vector.** The vector belongs to one model, and the profile would need a migration at each model change. The host stores the profile as text.
- **The stream is a date range of the collection.** Simple for a feed, but the exam stream has the dates of the teaching pool.
- **`taughtText` as a map.** A function lets the host read the texts from its store only when the profile has keywords.
- **One filter class with an optional calibration.** Then a reader must check the optional field to know what a probability means. Two classes make that state explicit.

## Consequences

- The host stores profiles, articles and vectors. The package keeps no state.
- A correction is `profile.with({ relevant: [...profile.relevant, id] })`, then `train` again.
- The eval runs the design through this API, so the eval measures the code that a host runs.
