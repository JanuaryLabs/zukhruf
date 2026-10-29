# @zukhruf/relevance-filtering

A reader wants the new articles of a feed that are about an interest, and not the others. This package decides, for each article of a stream, if it matches a profile of the reader. A profile has a name, one sentence that describes the interest, optional keywords, and the yes and no answers of the reader. The package compares each article with the sentence by embedding similarity. It makes each similarity a calibrated probability, adds the evidence of the keywords, and accepts the articles that give the best expected F0.5. This kind of program is also known as adaptive information filtering, as in TREC Filtering.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. The package does not start a model, a server or a database. Give it a vectors port that holds the vectors of the articles, for example a `Collection` of [`@zukhruf/embeddings`](../../embeddings), and the vector of the description from the same model.

See the [recipes](#recipes) for whole programs. The design comes from research round 6 of #3195, and it was frozen before its exam ([ADR 0002](./docs/adr/0002-the-design-is-frozen-by-research-round-6.md)). It was measured with EmbeddingGemma 2, with the document prompt for the articles and the query prompt for the description.

```sh
npm install @zukhruf/relevance-filtering @zukhruf/embeddings ai
```

```ts
import { DatabaseSync } from 'node:sqlite';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';

import { Collection } from '@zukhruf/embeddings';
import { Profile } from '@zukhruf/relevance-filtering';

const model = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
}).embeddingModel('embeddinggemma-2');
using database = new DatabaseSync('feed.sqlite');
const collection = new Collection({ database, model });
// The host upserts each article with the document prompt of the model:
// title: <title> | text: <title> <lead>.

const profile = new Profile({
  name: 'Security',
  description: 'Cybersecurity: attacks, breaches and the tools that stop them.',
  keywords: ['secur', 'cyber'],
  relevant: ['ransomware-hospital'],
  notRelevant: ['chip-plant'],
});
const { embedding } = await embed({
  model,
  value: `task: search result | query: ${profile.description}`,
});

const filter = profile.train({
  vectors: collection,
  descriptionVector: embedding,
  stream: newArticles, // [{ id, publishedAt, text: `${title} ${lead}` }, …]
  taughtText: (id) => textOf(id),
});

filter.accepted(); // the accepted ids, the most probable first
filter.probability(id); // from 0 to 1
```

## API

- `new Profile({ name, description, keywords?, relevant, notRelevant })` makes a profile. `relevant` and `notRelevant` are the ids of the articles that the reader answered yes and no for. An id in both lists is a `ConflictingAnswerError`. A profile does no I/O ([ADR 0001](./docs/adr/0001-a-profile-is-a-value-and-train-decides-on-one-stream.md)).
- `profile.with(changes)` gives a copy with the changed fields, for example a new answer. The profile does not change.
- `keywords` holds strings and regular expressions. A string matches at the start of a word, in any case: `secur` matches "Security" and "securing", but not "cybersecurity". A regular expression matches as it is ([ADR 0003](./docs/adr/0003-a-keyword-is-a-word-start-or-a-regular-expression.md)).
- `profile.train({ vectors, descriptionVector, stream, taughtText })` learns from the answers and decides on the stream. It gives a `CalibratedFilter` or a `KeywordFilter`.
  - `vectors` is the port to the vectors of the articles: `query(vector, { from, to })` and `fetch(ids)`. The `Collection` of `@zukhruf/embeddings` has this shape. The stream and the taught articles must be in it.
  - `descriptionVector` is the vector of the description, from the model of the stored vectors. Make it with the prompt that the model uses for a query.
  - `stream` is a list of one or more articles: `{ id, publishedAt, text }`. `publishedAt` is the date that the vectors store for the article. The keywords are matched in `text`, for example the title and the lead.
  - `taughtText(id)` gives the text of a taught relevant article, which the keywords are matched in. The filter calls it only when the profile has keywords.
- A filter gives `probability(id)`, `accepts(id)` and `accepted()`, the accepted ids with the most probable first, for each article of its stream.
- A `CalibratedFilter` (`kind: 'calibrated'`) comes from a profile with at least one relevant answer. It also gives its `calibration` (the binormal fit, or Platt's fit) and its `threshold`, the lowest accepted probability.
- A `KeywordFilter` (`kind: 'keywords'`) comes from a profile with no relevant answer, or when the binormal fit cannot hold and the profile has no not-relevant answer. It accepts the articles that match a keyword, with the probability 1, and gives 0 to the others.

## How it decides

1. **Similarity.** The similarity of each article is the cosine of its vector and the description vector. The answers do not change the similarity.
2. **Binormal model.** The filter standardises the similarities of the stream by their mean and standard deviation. It fits a relevant normal distribution and an other normal distribution by semi-supervised EM. The taught similarities stay in the component of their answer. The probability of an article is its posterior of the relevant component.
3. **Platt.** When the stream similarities are all equal, or the relevant mean falls to or below the other mean, the binormal fit cannot hold. Then Platt's method on the taught similarities gives the probabilities.
4. **Keyword evidence.** When the profile has keywords, naive Bayes adds the log likelihood ratio of a match, or of no match, to the log odds of each article.
5. **Threshold.** The filter accepts the m most probable articles, where m maximises the expected F0.5 of the stream.

## Errors

- `ConflictingAnswerError`: one id is a relevant and a not-relevant answer.
- `NoEvidenceError`: the profile has no relevant answer that the filter can learn from and no keyword.
- `MissingVectorError`: the vectors have no article of the stream with its publish date.
- `UnknownArticleError`: `probability` or `accepts` got an id that is not in the stream.
- `RangeError`: the stream has one id two times.
- The error of the vectors port, for example the `UnknownDocumentError` of `@zukhruf/embeddings`: a taught article is not in the vectors.

## Result

Round 6 of the research taught each profile the way the reader teaches: yes or no on the top 5 or 10 articles by similarity and the top 5 or 10 keyword matches in the first 14 days of a slice of the feed. On the rest of two slices (2025-10 to 2025-12 and 2026-01 to 2026-03, 10 scored profiles), the package gives:

| Design               | Macro T11F | Macro Brier skill |
| -------------------- | ---------- | ----------------- |
| This package         | 0.701      | +0.512            |
| The reader's keyword | 0.656      | none              |
| Broader keywords     | 0.528      | none              |
| Accept every article | 0.067      | none              |

The 95% interval of (package - keyword) is [-0.019, +0.118]: the package is not worse than the typed keyword by more than 0.05, and its probabilities are calibrated. `nx run relevance-filtering:eval` gives these numbers through the package ([eval/README.md](./eval/README.md)).

## Limits

- The design is valid only with EmbeddingGemma 2, the vector text of event grouping (`title: <title> | text: <title>\n<lead>`) for the articles and the query prompt for the description. Another model gives another similarity scale.
- The binormal model is fitted on the stream. A stream of a few articles gives a weak fit. The research streams held 1,600 to 1,700 articles.
- When the answers are only the most similar articles of a large pool, the taught relevant similarities are far above the relevant articles of the stream. Then the fit gives too low probabilities (see "Rehearsal" in [eval/README.md](./eval/README.md)).
- A keyword string matches at the start of a word only. Type each part that you want: `cyber` and `secur` for "cybersecurity".
- The filter reads the vectors of the whole publish range of the stream. A stream that spans a long time reads many vectors.

## Decisions

Before you change a step of the design, read ADR 0002, and run `nx run relevance-filtering:eval` before and after the change.

- [ADR 0001: A profile is a value, and train decides on one stream](./docs/adr/0001-a-profile-is-a-value-and-train-decides-on-one-stream.md)
- [ADR 0002: The design is frozen by research round 6](./docs/adr/0002-the-design-is-frozen-by-research-round-6.md)
- [ADR 0003: A keyword is a word start or a regular expression](./docs/adr/0003-a-keyword-is-a-word-start-or-a-regular-expression.md)
- [Code copied from the event-grouping eval](./docs/copied-code.md)

## Recipes

- [Filter the new articles of a feed with a taught profile](./docs/recipes/filter-a-feed-with-a-taught-profile.md)
- [Start a profile with keywords, then teach it](./docs/recipes/start-with-keywords-then-teach.md)
