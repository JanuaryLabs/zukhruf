# Recipe: Start a profile with keywords, then teach it

**Use case.** A reader makes a new interest, "Robots". The reader typed keywords, but did not answer for any article yet. The reader must see articles at once. After the reader answers for some of them, the filter must learn from the answers.

**What you need.** An embedding model that is ready, for example EmbeddingGemma 2 on a llama.cpp server, and a SQLite database for the vectors.

## The steps

1. Make the profile with keywords and no answers. `train` gives a `KeywordFilter`: it accepts the articles that match a keyword, with the probability 1.
2. The reader answers yes or no for the shown articles.
3. Make the corrected profile with `profile.with`. `train` now gives a `CalibratedFilter`, with calibrated probabilities.

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
import { type Article, Profile } from '@zukhruf/relevance-filtering';

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
const stream = items.map(([id, title, lead]): Article => ({
  id,
  publishedAt,
  text: `${title} ${lead}`,
}));
const [first, ...rest] = stream;
if (first === undefined) throw new Error('No article.');
const textOf = (id: string) =>
  stream.find((article) => article.id === id)?.text ?? '';

const profile = new Profile({
  name: 'Robots',
  description: 'Robots and autonomous machines that work in the real world.',
  keywords: ['robot'],
  relevant: [],
  notRelevant: [],
});
const { embedding } = await embed({
  model,
  value: `task: search result | query: ${profile.description}`,
});
const options = {
  vectors: collection,
  descriptionVector: embedding,
  stream: [first, ...rest] as const,
  taughtText: textOf,
};

const keywords = profile.train(options);
console.log(keywords.kind, keywords.accepted());

// The reader says yes to two shown articles and no to one.
const taught = profile.with({
  relevant: ['humanoid-factory', 'warehouse-arms'],
  notRelevant: ['robot-vacuum'],
});
const calibrated = taught.train(options);
console.log(calibrated.kind);
for (const id of calibrated.accepted())
  console.log(calibrated.probability(id).toFixed(2), id);
```

## What it prints

With EmbeddingGemma 2 Q8_0 on llama.cpp b11836, it prints:

```text
keywords [ 'humanoid-factory', 'robotaxi-city', 'warehouse-arms', 'robot-vacuum' ]
calibrated
0.96 humanoid-factory
0.93 warehouse-arms
```

The keyword filter accepts each article with "robot" at the start of a word, also the price cut of the vacuum maker. It does not see the drone article, which has no keyword. The calibrated filter learns from the answers: it accepts the two articles that the reader said yes to, and no other article of this stream of 12.

## Notes

- A keyword filter gives the probability 1 or 0. It is not calibrated, so do not compare its probabilities with those of a calibrated filter.
- In this program the stream also holds the answered articles. A real reader answers for articles that it showed before, and decides on new ones.
