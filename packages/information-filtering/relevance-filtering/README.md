# @zukhruf/relevance-filtering

A reader wants the new articles of a feed that are about an interest, and not the others. This package ranks the articles of a stream for one interest of the reader, the best first, so a reader can show the best N articles of each day. A scorer, made for one interest, gives each article a probability and ranks the stream by it. This kind of program is also known as routing, as in TREC. A threshold that the host chooses can turn the probabilities into a yes or no for an action, for example a notification.

The package has three scorers:

- **`DecisionScorer`** asks a decision model, through the AI SDK, if the main subject of each article is the description of the interest. It ranked best in research rounds 13 and 14, and it needs nothing but the description.
- **`SimilarityScorer`** compares each article with the description by embedding similarity, makes each similarity a calibrated probability from the reader's yes and no answers, and adds the evidence of the keywords. It needs at least one yes answer.
- **`KeywordScorer`** is the cold start of the similarity design: the articles that match a keyword come first. It needs at least one keyword.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. The package does not start a model, a server or a database. See the [recipes](#recipes) for whole programs.

```sh
npm install @zukhruf/relevance-filtering ai
```

### With a decision model

Give the scorer an AI SDK decision model, for example Liquid AI's d1-2B on a llama.cpp server through `@ai-sdk/typesafe-ai`, and the description of the interest.

```ts
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';

import { DecisionScorer, UtilityThreshold } from '@zukhruf/relevance-filtering';

const scorer = new DecisionScorer({
  model: createTypeSafeAi({
    baseURL: 'http://127.0.0.1:9931/v1',
    apiKey: 'none',
  }).decisionModel('LiquidAI/d1-2B-GGUF:Q8_0'),
  description: 'Cybersecurity: attacks, breaches and the tools that stop them.',
});

// The new articles by id: { publishedAt, text: `${title} ${lead}` }.
const scores = await scorer.score(newArticles);

// The best 5 articles of one day, the best first.
scores.ranked({ from: dayStart, to: dayEnd }).slice(0, 5);
scores.probability(id); // from 0 to 1
// Notify only when a miss costs three times as much as a false alarm.
scores.accepted(new UtilityThreshold({ falseAlarm: 1, miss: 3 }));
```

### With embeddings

Give the scorer a vectors port that holds the vectors of the articles, for example a `Collection` of [`@zukhruf/embeddings`](../../embeddings), and the vector of the description from the same model. The design comes from research round 6 of #3195, and it was frozen before its exam ([ADR 0002](./docs/adr/0002-the-design-is-frozen-by-research-round-6.md)). It was measured with EmbeddingGemma 2, with the document prompt for the articles and the query prompt for the description.

```ts
import { DatabaseSync } from 'node:sqlite';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';

import { Collection } from '@zukhruf/embeddings';
import {
  KeywordScorer,
  SimilarityScorer,
  TaughtAnswers,
} from '@zukhruf/relevance-filtering';

const model = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
}).embeddingModel('embeddinggemma-2');
using database = new DatabaseSync('feed.sqlite');
const collection = new Collection({ database, model });
// The host upserts each article with the document prompt of the model:
// title: <title> | text: <title> <lead>.

const description =
  'Cybersecurity: attacks, breaches and the tools that stop them.';
const { embedding: descriptionVector } = await embed({
  model,
  value: `task: search result | query: ${description}`,
});

// The reader's answers by article id, each with the text of its article.
const answers = TaughtAnswers.parse(
  new Map([
    ['ransomware-hospital', { relevant: true, text: 'Ransomware hits …' }],
    ['chip-plant', { relevant: false, text: 'A chip plant opens …' }],
  ]),
);
const scorer =
  answers === undefined
    ? new KeywordScorer({
        vectors: collection,
        descriptionVector,
        keywords: ['secur', 'cyber'],
      })
    : new SimilarityScorer({
        vectors: collection,
        descriptionVector,
        answers,
        keywords: ['secur', 'cyber'],
      });

const scores = await scorer.score(newArticles);
scores.ranked({ from: dayStart, to: dayEnd }).slice(0, 5);
```

## API

- A `Scorer` has `score(stream)`, which gives a `Promise` of `Scores`. A scorer is made for one interest ([ADR 0006](./docs/adr/0006-a-scorer-is-made-for-one-interest-and-its-inputs-rule-out-illegal-states.md)). The `stream` is a map from article id to `{ publishedAt, text }`; `text` is, for example, the title and the lead. It can be empty.
- `new DecisionScorer({ model, description })` takes an AI SDK decision model and the description. For each article, it asks the model "Is the main subject of this article: <description>?" about `text`, one article at a time.
- `new SimilarityScorer({ vectors, descriptionVector, answers, keywords })` is the frozen design for an interest with at least one yes answer.
  - `vectors` is the port to the vectors of the articles: `query(vector, { from, to })` and `fetch(ids)`. The `Collection` of `@zukhruf/embeddings` has this shape. The stream and the taught articles must be in it, and `publishedAt` must be the date that the vectors store for the article.
  - `descriptionVector` is the vector of the description from the model of the stored vectors, made with the prompt that the model uses for a query.
  - `answers` is a `TaughtAnswers`. `keywords` holds strings and regular expressions, and can be empty. A string matches at the start of a word, in any case: `secur` matches "Security" and "securing", but not "cybersecurity". A regular expression matches as it is ([ADR 0003](./docs/adr/0003-a-keyword-is-a-word-start-or-a-regular-expression.md)).
  - It ranks by the calibrated probability, then by similarity, then by id. When neither the binormal fit nor Platt's method can hold, it ranks the keyword matches first, the newest first, and then the other articles by similarity, with the probability 1 for a match and 0 for the others.
- `TaughtAnswers.parse(answers)` takes the reader's answers as a map from article id to `{ relevant, text }`, and gives `undefined` when no answer is a yes.
- `new KeywordScorer({ vectors, descriptionVector, keywords })` is the cold start: `keywords` has at least one keyword. It ranks the matches first, the newest first, and then the other articles by similarity. Its probability is 1 for a match and 0 for the others, and it is not calibrated.
- `Scores` gives `ranked(range?)`: the ids of the stream, the best first. With `{ from, to }`, only the articles published in that range, in the same order. The best N of a day are `ranked({ from, to }).slice(0, n)` ([ADR 0004](./docs/adr/0004-the-reader-ranks-and-does-not-decide-yes-or-no.md)). It also gives `probability(id)`, and `accepted(threshold)`: the articles that the threshold accepts, in the order of `ranked()`.
- A `Threshold` has `cut(scores)`, which gives the lowest probability to accept (`Infinity` accepts nothing).
  - `new UtilityThreshold({ falseAlarm, miss })` accepts when p >= falseAlarm / (falseAlarm + miss), the Bayes decision rule for calibrated probabilities. The two costs are finite, 0 or more, and not both 0.
  - `new ExpectedFThreshold({ beta })` accepts the m most probable articles, where m maximises the expected F-beta of the stream. With beta 0.5 it is the threshold of the frozen design.
- To add a method, implement `Scorer` or `Threshold`. A scorer gives `new Scores(ranked)`, with `ranked` a map from article id to `{ publishedAt, probability }` in its order.

## Rank, then decide for each action

Show the ranking, and decide yes or no only for an action that needs it. Research round 9 tested the yes/no decisions of the frozen design on July to September 2025, and every design lost to the typed keyword: the threshold that a few taught answers set is weak. The ranking was strong, so the user chose a ranked reader on 2026-10-29 ([ADR 0004](./docs/adr/0004-the-reader-ranks-and-does-not-decide-yes-or-no.md)). The probabilities of the decision model were calibrated on January to March 2025 (Brier skill +0.726), but the calibration changed with the answer key (+0.356 with a second key, round 14). Choose a threshold for each action from what a miss and a false alarm cost. See [the research record](../../../docs/research/relevance-filtering.md) and [ADR 0005](./docs/adr/0005-a-scorer-and-a-threshold-are-ports.md).

## How the similarity scorer ranks

1. **Similarity.** The similarity of each article is the cosine of its vector and the description vector. The answers do not change the similarity.
2. **Binormal model.** The scorer standardises the similarities of the stream by their mean and standard deviation. It fits a relevant normal distribution and an other normal distribution by semi-supervised EM. The taught similarities stay in the component of their answer. The probability of an article is its posterior of the relevant component.
3. **Platt.** When the stream similarities are all equal, or the relevant mean falls to or below the other mean, the binormal fit cannot hold. Then Platt's method on the taught similarities gives the probabilities, when at least one answer is a no.
4. **Keyword evidence.** When there are keywords, naive Bayes adds the log likelihood ratio of a match, or of no match, to the log odds of each article.
5. **Order.** The scorer ranks the stream by the probability, then by the similarity, then by id.

## Errors

- `MissingVectorError`: the vectors have no article of the stream with its publish date.
- `UnknownArticleError`: `probability` got an id that is not in the stream.
- `RangeError`: the costs of a `UtilityThreshold` give no threshold.
- The error of the vectors port, for example the `UnknownDocumentError` of `@zukhruf/embeddings`: a taught article is not in the vectors.
- The errors of the AI SDK, for example `Experimental_DecisionRefusalError` when the decision model refuses a question. The decision scorer gives no probability in place of a refused or failed call.

## Result

Rounds 13 and 14 ranked January to March 2025 (1,370 articles) for each research profile. The score is MAP over the profiles with at least 20 strict relevant articles:

| Answer key                               | Decision scorer (d1-2B) | Similarity scorer | The reader's keyword list |
| ---------------------------------------- | ----------------------- | ----------------- | ------------------------- |
| Claude annotators (round 13, 7 profiles) | 0.924                   | 0.782             | 0.498                     |
| GPT annotators (round 14, 12 profiles)   | 0.808                   | 0.634             | 0.402                     |

The 95% interval of (decision scorer - similarity scorer) is [+0.049, +0.298] and [+0.094, +0.278]. The decision scorer was better on each of the 12 profiles of round 14.

Round 10 ranked July to September 2025 (1,617 articles) after product teaching: the reader shows the top 5 or 10 articles by similarity and the top 5 or 10 keyword matches, and the person answers yes or no. The score is MAP over the profiles with at least 15 strict relevant articles in the ranked stream:

| Teaching                                    | Similarity scorer | The reader's keyword list | Broader keywords | Newest first |
| ------------------------------------------- | ----------------- | ------------------------- | ---------------- | ------------ |
| The first 14 days of the slice (9 profiles) | 0.717             | 0.514                     | 0.486            | 0.065        |
| The three earlier slices (11 profiles)      | 0.766             | 0.476                     | 0.462            | 0.055        |

A keyword list puts the matches first, the newest first. The 95% interval of (similarity scorer - keyword list) is [+0.082, +0.296] and [+0.215, +0.374]. `nx run relevance-filtering:eval -- ranking` gives these numbers through the package, to 1e-15 ([eval/README.md](./eval/README.md)).

## Limits

- The decision scorer was measured only with d1-2B (Q8_0), the question of round 13, and the title and the lead as the text. Another model or another question needs a new research round.
- The decision scorer calls the model once for each article of the stream. The host decides when to score and if it keeps the scores.
- The answer keys of rounds 13 and 14 come from language models. No person labelled that slice (limitation 16 of the research record).
- The similarity design is valid only with EmbeddingGemma 2, the vector text of event detection (`title: <title> | text: <title>\n<lead>`) for the articles and the query prompt for the description. Another model gives another similarity scale.
- The binormal model is fitted on the stream. A stream of a few articles gives a weak fit. The research streams held 1,600 to 1,700 articles.
- When the answers are only the most similar articles of a large pool, the taught relevant similarities are far above the relevant articles of the stream. Then the probabilities of the similarity scorer are too low, and a threshold accepts too few articles. The order stays good.
- With one yes answer, the relevant standard deviation sits at its floor, and the keyword evidence sets most of the order.
- A keyword string matches at the start of a word only. Type each part that you want: `cyber` and `secur` for "cybersecurity".
- The similarity and keyword scorers read the vectors of the whole publish range of the stream. A stream that spans a long time reads many vectors.

## Decisions

Before you change a step of the similarity design, read ADR 0002, and run `nx run relevance-filtering:eval` before and after the change.

- [ADR 0001: A profile is a value, and train decides on one stream](./docs/adr/0001-a-profile-is-a-value-and-train-decides-on-one-stream.md) (superseded)
- [ADR 0002: The design is frozen by research round 6](./docs/adr/0002-the-design-is-frozen-by-research-round-6.md)
- [ADR 0003: A keyword is a word start or a regular expression](./docs/adr/0003-a-keyword-is-a-word-start-or-a-regular-expression.md)
- [ADR 0004: The reader ranks, and does not decide yes or no](./docs/adr/0004-the-reader-ranks-and-does-not-decide-yes-or-no.md)
- [ADR 0005: A scorer and a threshold are ports](./docs/adr/0005-a-scorer-and-a-threshold-are-ports.md)
- [ADR 0006: A scorer is made for one interest, and its inputs rule out illegal states](./docs/adr/0006-a-scorer-is-made-for-one-interest-and-its-inputs-rule-out-illegal-states.md)
- [Code copied from the event-detection eval](./docs/copied-code.md)

## Recipes

- [Rank a feed with a decision model](./docs/recipes/rank-a-feed-with-a-decision-model.md)
- [Show the best articles of each day with taught answers](./docs/recipes/filter-a-feed-with-a-taught-profile.md)
- [Start an interest with keywords, then teach it](./docs/recipes/start-with-keywords-then-teach.md)
