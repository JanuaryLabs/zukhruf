# Recipe: Start an interest with keywords, then teach it

**Use case.** A reader makes a new interest, "Robots". The reader typed keywords, but did not answer for any article yet. The reader must see articles at once. After the reader answers for some of them, the ranking must learn from the answers.

**What you need.** An embedding model that is ready, for example EmbeddingGemma 2 on a llama.cpp server, and a SQLite database for the vectors.

## The steps

1. The interest has keywords and no answers, so make a `KeywordScorer`. It ranks the articles that match a keyword first, the newest first, and then the other articles by similarity.
2. The reader answers yes or no for the shown articles.
3. Parse the answers into `TaughtAnswers`. With at least one yes, make a `SimilarityScorer` and score again. Now the scorer ranks by calibrated probabilities.

## The program

This program needs a llama.cpp server with EmbeddingGemma 2:

```sh
llama-server -m embeddinggemma-2-Q8_0.gguf --alias embeddinggemma-2 --port 8080 --embedding
```

```ts title="start-with-keywords.ts"
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
  baseURL: process.env.EMBEDDING_URL ?? 'http://127.0.0.1:8080/v1',
}).embeddingModel('embeddinggemma-2');

const items = [
  [
    'humanoid-factory',
    'Humanoid robots start work in a car factory',
    'The robots carry parts between the lines.',
  ],
  [
    'robotaxi-city',
    'Robotaxi service opens in a new city',
    'Riders can call a car with no driver from an app.',
  ],
  [
    'warehouse-arms',
    'Robot arms learn to pick new items in one try',
    'The model learned from videos of people.',
  ],
  [
    'robot-vacuum',
    'Robot vacuum maker cuts prices',
    'The company sells more models in Europe.',
  ],
  [
    'drone-delivery',
    'Drones deliver medicine to remote villages',
    'Each drone flies 80 km on one battery.',
  ],
  [
    'chip-export',
    'Government limits exports of AI chips',
    'The rule covers processors for training models.',
  ],
  [
    'bank-breach',
    'Bank confirms breach of customer data',
    'Hackers took names and account numbers.',
  ],
  [
    'earnings-cloud',
    'Cloud company beats revenue forecast',
    'Sales grew 30% this quarter.',
  ],
  [
    'court-copyright',
    'Court rules on copyright of training data',
    'The judge says the use was fair.',
  ],
  [
    'school-chatbot',
    'Schools test a chatbot for homework help',
    'Teachers say students like it.',
  ],
  [
    'nuclear-deal',
    'Data center signs nuclear power deal',
    'The plant gives power for 20 years.',
  ],
  [
    'open-model',
    'Lab releases an open-weight coding model',
    'It runs on one GPU.',
  ],
] as const;

using database = new DatabaseSync(':memory:');
const collection = new Collection({ database, model });
const publishedAt = new Date('2026-10-20T00:00:00Z');
await collection.upsert(
  items.map(([id, title, lead]) => ({
    id,
    text: `title: ${title} | text: ${title}\n${lead}`,
    publishedAt,
  })),
);
const stream = new Map(
  items.map(([id, title, lead]) => [
    id,
    { publishedAt, text: `${title} ${lead}` },
  ]),
);
const description =
  'Robots and autonomous machines that work in the real world.';
const { embedding: descriptionVector } = await embed({
  model,
  value: `task: search result | query: ${description}`,
});

const keywords = await new KeywordScorer({
  vectors: collection,
  descriptionVector,
  keywords: ['robot'],
}).score(stream);
console.log(keywords.ranked().slice(0, 5));

// The reader says yes to two shown articles and no to one.
const answer = (id: string, relevant: boolean) =>
  [id, { relevant, text: stream.get(id)?.text ?? '' }] as const;
const answers = TaughtAnswers.parse(
  new Map([
    answer('humanoid-factory', true),
    answer('warehouse-arms', true),
    answer('robot-vacuum', false),
  ]),
);
if (answers === undefined) throw new Error('The reader said yes to nothing.');
const calibrated = await new SimilarityScorer({
  vectors: collection,
  descriptionVector,
  answers,
  keywords: ['robot'],
}).score(stream);
for (const id of calibrated.ranked().slice(0, 5))
  console.log(calibrated.probability(id).toFixed(3), id);
```

## What it prints

With EmbeddingGemma 2 Q8_0 on llama.cpp b11960, it prints:

```text
[
  'humanoid-factory',
  'robot-vacuum',
  'robotaxi-city',
  'warehouse-arms',
  'school-chatbot'
]
0.961 humanoid-factory
0.928 warehouse-arms
0.000 robot-vacuum
0.000 robotaxi-city
0.000 school-chatbot
```

The keyword scorer puts the four articles with "robot" at the start of a word first. They have one publish date, so they sort by id. Then the other articles come by similarity: the drone article has no keyword, and it is not in the top 5. The similarity scorer puts the two articles that the reader said yes to first, and gives a low probability to the vacuum article that the reader said no to.

## Notes

- The keyword scorer gives the probability 1 or 0. It is not calibrated, so do not compare it with the probabilities of a similarity scorer.
- In this program the stream also holds the answered articles. A real reader answers for articles that it showed before, and decides on new ones.
