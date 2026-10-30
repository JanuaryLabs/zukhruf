# Recipe: Show the best articles of each day with taught answers

**Use case.** A news reader stores the articles of its feeds. A reader has an interest, "Security". Last week, the reader answered yes or no for some articles. This week, 24 new articles came. For each day, the reader wants to see the best 2 articles for security, the best first.

**What you need.** An embedding model that is ready, for example EmbeddingGemma 2 on a llama.cpp server, and a SQLite database for the vectors.

## The steps

1. Upsert each article into a `Collection` of `@zukhruf/embeddings`, with the document prompt of the model as its text.
2. Embed the description of the interest with the query prompt of the model.
3. Parse the reader's answers, each with the text of its article, into `TaughtAnswers`.
4. Make a `SimilarityScorer` for the interest with the collection, the description vector, the answers and the keywords, and score the new articles.
5. For each day, show `scores.ranked({ from, to }).slice(0, n)`. Each id has its probability.

## The program

This program needs a llama.cpp server with EmbeddingGemma 2:

```sh
llama-server -m embeddinggemma-2-Q8_0.gguf --alias embeddinggemma-2 --port 8080 --embedding
```

```ts title="filter-a-feed.ts"
import { DatabaseSync } from 'node:sqlite';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';

import { Collection } from '@zukhruf/embeddings';
import { SimilarityScorer, TaughtAnswers } from '@zukhruf/relevance-filtering';

const model = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: process.env.EMBEDDING_URL ?? 'http://127.0.0.1:8080/v1',
}).embeddingModel('embeddinggemma-2');

type Item = { id: string; day: number; title: string; lead: string };

// Last week: the reader answered yes or no for these articles.
const answered: Item[] = [
  {
    id: 'ransomware-hospital',
    day: 1,
    title: 'Ransomware gang hits hospital network',
    lead: 'Attackers encrypted patient records and asked for a payment in bitcoin.',
  },
  {
    id: 'patch-tuesday',
    day: 2,
    title: 'Microsoft fixes six zero-day flaws',
    lead: 'The monthly update closes vulnerabilities that attackers already use.',
  },
  {
    id: 'chip-plant',
    day: 2,
    title: 'New chip plant opens in Arizona',
    lead: 'The factory will make processors for data centers from next year.',
  },
  {
    id: 'security-funding',
    day: 3,
    title: 'Security startup raises $40M for AI agents',
    lead: 'The company finds attacks that target AI agents in enterprise networks.',
  },
];

// Today: the new articles of the feed.
const today: Item[] = [
  {
    id: 'phishing-kits',
    day: 8,
    title: 'Phishing kits doubled in 2025, report says',
    lead: 'Criminals used new kits to steal passwords from bank customers.',
  },
  {
    id: 'breach-retailer',
    day: 8,
    title: 'Retailer confirms data breach of 2 million customers',
    lead: 'Hackers took names, addresses and card numbers from its online store.',
  },
  {
    id: 'vpn-flaw',
    day: 8,
    title: 'Critical VPN vulnerability lets attackers take over devices',
    lead: 'The vendor asks customers to install the patch now.',
  },
  {
    id: 'botnet-takedown',
    day: 9,
    title: 'Police take down botnet of 300,000 routers',
    lead: 'The malware used the routers to attack websites.',
  },
  {
    id: 'cybersecurity-merger',
    day: 9,
    title: 'Two cybersecurity firms agree to merge',
    lead: 'The deal joins a cloud security company and an identity company.',
  },
  {
    id: 'password-manager',
    day: 9,
    title: 'Password manager adds passkeys for families',
    lead: 'Users can share sign-in keys without sharing passwords.',
  },
  {
    id: 'spyware-phones',
    day: 10,
    title: 'Spyware found on phones of journalists',
    lead: 'Researchers say the attack used a flaw in a messaging app.',
  },
  {
    id: 'gpu-launch',
    day: 8,
    title: 'Nvidia shows its next GPU for data centers',
    lead: 'The chip doubles the memory of the last generation.',
  },
  {
    id: 'robot-warehouse',
    day: 8,
    title: 'Warehouse robots now pick 1 million items a day',
    lead: 'The retailer says the robots work next to people.',
  },
  {
    id: 'earnings-cloud',
    day: 9,
    title: 'Cloud company beats revenue forecast',
    lead: 'Sales grew 30% as more customers moved to its platform.',
  },
  {
    id: 'chatbot-school',
    day: 9,
    title: 'Schools test a chatbot for homework help',
    lead: 'Teachers say students ask it to explain math problems.',
  },
  {
    id: 'open-model',
    day: 9,
    title: 'Lab releases an open-weight model for coding',
    lead: 'Developers can run the model on one GPU.',
  },
  {
    id: 'court-copyright',
    day: 10,
    title: 'Court rules on copyright of AI training data',
    lead: 'The judge says the use of books to train a model was fair use.',
  },
  {
    id: 'energy-datacenter',
    day: 10,
    title: 'Data center signs nuclear power deal',
    lead: 'The plant will give power to servers for 20 years.',
  },
  {
    id: 'jobs-report',
    day: 10,
    title: 'AI changes the jobs of call center workers',
    lead: 'A study finds that new workers learn faster with an assistant.',
  },
  {
    id: 'quantum-qubits',
    day: 11,
    title: 'Quantum computer reaches 1,000 qubits',
    lead: 'The company says error rates also fell.',
  },
  {
    id: 'health-diagnosis',
    day: 11,
    title: 'AI finds early signs of lung disease in scans',
    lead: 'Doctors in the trial confirmed most of its findings.',
  },
  {
    id: 'funding-robotics',
    day: 11,
    title: 'Robotics startup raises $100M',
    lead: 'The money will build humanoid robots for factories.',
  },
  {
    id: 'phone-launch',
    day: 11,
    title: 'New phone has a bigger battery',
    lead: 'The phone lasts two days on one charge.',
  },
  {
    id: 'regulation-eu',
    day: 12,
    title: 'EU adopts rules for general-purpose AI models',
    lead: 'Providers must publish a summary of their training data.',
  },
  {
    id: 'chips-export',
    day: 12,
    title: 'Government limits exports of advanced chips',
    lead: 'The rule covers processors for AI training.',
  },
  {
    id: 'coding-agent',
    day: 12,
    title: 'Coding agent writes and tests whole features',
    lead: 'Developers review the changes before they merge them.',
  },
  {
    id: 'safety-eval',
    day: 12,
    title: 'Lab publishes new safety tests for AI models',
    lead: 'The tests check if a model hides its goals.',
  },
  {
    id: 'search-update',
    day: 12,
    title: 'Search engine shows AI answers in more countries',
    lead: 'The feature now works in 40 languages.',
  },
];

using database = new DatabaseSync(':memory:');
const collection = new Collection({ database, model });
const all = [...answered, ...today];
await collection.upsert(
  all.map(({ id, day, title, lead }) => ({
    id,
    text: `title: ${title} | text: ${title}\n${lead}`,
    publishedAt: new Date(Date.UTC(2026, 9, day)),
  })),
);

const description =
  'Cybersecurity: attacks, breaches, vulnerabilities and the tools that stop them.';
const { embedding: descriptionVector } = await embed({
  model,
  value: `task: search result | query: ${description}`,
});
const textOf = (item: Item) => `${item.title} ${item.lead}`;
// The reader said yes to three articles and no to one, by article id.
const yes = new Set([
  'ransomware-hospital',
  'patch-tuesday',
  'security-funding',
]);
const answers = TaughtAnswers.parse(
  new Map(
    answered
      .filter(({ id }) => yes.has(id) || id === 'chip-plant')
      .map((item) => [
        item.id,
        { relevant: yes.has(item.id), text: textOf(item) },
      ]),
  ),
);
if (answers === undefined) throw new Error('The reader said yes to nothing.');

const scorer = new SimilarityScorer({
  vectors: collection,
  descriptionVector,
  answers,
  keywords: ['secur', 'cyber', 'hack'],
});
const scores = await scorer.score(
  new Map(
    today.map((item) => [
      item.id,
      {
        publishedAt: new Date(Date.UTC(2026, 9, item.day)),
        text: textOf(item),
      },
    ]),
  ),
);

const best = 2;
for (let day = 8; day <= 12; day++) {
  const from = new Date(Date.UTC(2026, 9, day));
  const to = new Date(Date.UTC(2026, 9, day + 1) - 1);
  for (const id of scores.ranked({ from, to }).slice(0, best))
    console.log(
      from.toISOString().slice(0, 10),
      scores.probability(id).toFixed(3),
      id,
    );
}
```

## What it prints

The probabilities are calibrated, because the reader said yes to some articles. With EmbeddingGemma 2 Q8_0 on llama.cpp b11960, it prints:

```text
2026-10-08 0.639 phishing-kits
2026-10-08 0.000 breach-retailer
2026-10-09 0.765 botnet-takedown
2026-10-09 0.000 cybersecurity-merger
2026-10-10 0.673 spyware-phones
2026-10-10 0.000 energy-datacenter
2026-10-11 0.000 quantum-qubits
2026-10-11 0.000 health-diagnosis
2026-10-12 0.000 safety-eval
2026-10-12 0.000 coding-agent
```

On the days with security articles, they come first. The days 11 and 12 have no security article, so their best articles are about other interests. A reader can hide an article with a low probability, but that is a threshold again.

The probabilities are low for most security articles: a stream of 24 articles gives a weak binormal fit, and the relevant component has the standard deviation 0.10 of the standardised scale. The order still puts them first. The research streams had about 1,700 articles.

## Notes

- The calibration is fitted on the articles of `stream`, so rank the stream of the whole period, and cut it into days with `ranked({ from, to })`. A stream of 24 articles gives a weak fit. A real feed has hundreds of articles in a day.
- Show the ranking. Use `scores.accepted(threshold)` only for an action that needs a yes or no, with a threshold from the costs of that action ([ADR 0005](../adr/0005-a-scorer-and-a-threshold-are-ports.md)).
- Give `publishedAt` as the collection stores it. The scorer reads the similarities of the stream with one `query` over the publish dates of the stream.
- To add an answer, add it to the map, parse it again, and make a new scorer.
