# Recipe: Filter the new articles of a feed with a taught profile

**Use case.** A news reader stores the articles of its feeds. A reader has an interest, "Security". Last week, the reader answered yes or no for some articles. Today, 24 new articles came. The reader wants only the new articles about security, with the most probable first.

**What you need.** An embedding model that is ready, for example EmbeddingGemma 2 on a llama.cpp server, and a SQLite database for the vectors.

## The steps

1. Upsert each article into a `Collection` of `@zukhruf/embeddings`, with the document prompt of the model as its text.
2. Make the profile: the name, the description, the keywords and the answers of the reader.
3. Embed the description with the query prompt of the model.
4. Call `profile.train` with the collection, the description vector, the new articles and the texts of the answered articles.
5. Show `filter.accepted()`. Each id has its probability.

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
import { Profile } from '@zukhruf/relevance-filtering';

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

const profile = new Profile({
  name: 'Security',
  description:
    'Cybersecurity: attacks, breaches, vulnerabilities and the tools that stop them.',
  keywords: ['secur', 'cyber', 'hack'],
  relevant: ['ransomware-hospital', 'patch-tuesday', 'security-funding'],
  notRelevant: ['chip-plant'],
});
const { embedding } = await embed({
  model,
  value: `task: search result | query: ${profile.description}`,
});

const textOf = (id: string) => {
  const item = all.find((article) => article.id === id);
  return item === undefined ? '' : `${item.title} ${item.lead}`;
};
const [first, ...rest] = today.map(({ id, day }) => ({
  id,
  publishedAt: new Date(Date.UTC(2026, 9, day)),
  text: textOf(id),
}));
if (first === undefined) throw new Error('No new article.');

const filter = profile.train({
  vectors: collection,
  descriptionVector: embedding,
  stream: [first, ...rest],
  taughtText: textOf,
});

console.log(filter.kind);
for (const id of filter.accepted())
  console.log(filter.probability(id).toFixed(2), id);
```

## What it prints

The filter is calibrated, because the profile has relevant answers. With EmbeddingGemma 2 Q8_0 on llama.cpp b11836, it prints:

```text
calibrated
0.76 botnet-takedown
0.67 spyware-phones
0.64 phishing-kits
```

Each article about another interest gets a probability below 0.001. The filter also gives a probability below 0.001 to four security articles: the retailer breach, the VPN flaw, the merger and the password manager. A stream of 24 articles gives a weak binormal fit: the relevant component has the standard deviation 0.10 of the standardised scale, so only the articles nearest to the answers get a high probability. The research streams had about 1,700 articles.

## Notes

- The calibration is fitted on the articles of `stream`. A stream of 24 articles gives a weak fit. A real feed has hundreds of articles in a day.
- Give `publishedAt` as the collection stores it. The filter reads the similarities of the stream with one `query` over the publish dates of the stream.
- To add an answer, call `profile.with({ relevant: [...profile.relevant, id] })` and train again.
