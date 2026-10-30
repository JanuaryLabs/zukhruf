# Recipe: Rank a feed with a decision model

**Use case.** A news reader has two interests, "Security" and "Chips". The reader did not answer for any article yet. For each day, the reader wants the best 2 articles of each interest, and a notification for each article that is probably about the interest.

**What you need.** A decision model that the AI SDK can call, for example Liquid AI's d1-2B on a llama.cpp server, and the `@ai-sdk/typesafe-ai` provider. The scorer needs no embeddings and no answers.

## The steps

1. Make the AI SDK decision model once.
2. For each interest, make a `DecisionScorer` with the model and the description of the interest. The scorer reads nothing else.
3. Score the articles, a map by article id. The scorer asks the model one question for each article.
4. For each day, show `scores.ranked({ from, to }).slice(0, n)`.
5. For the notification, choose a threshold from what a miss and a false alarm cost.

## The program

This program needs a llama.cpp server that serves d1-2B:

```sh
llama serve -hf LiquidAI/d1-2B-GGUF:Q8_0
```

```sh
npm install @zukhruf/relevance-filtering ai @ai-sdk/typesafe-ai zod
```

```ts title="rank-with-a-decision-model.ts"
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';

import { DecisionScorer, UtilityThreshold } from '@zukhruf/relevance-filtering';

const model = createTypeSafeAi({
  baseURL: process.env.DECISION_URL ?? 'http://127.0.0.1:9931/v1',
  apiKey: 'none',
}).decisionModel('LiquidAI/d1-2B-GGUF:Q8_0');

const items = [
  [
    8,
    'ransomware-hospital',
    'Ransomware gang hits a hospital network',
    'Doctors move to paper records while the systems are down.',
  ],
  [
    8,
    'gpu-launch',
    'Nvidia shows its next AI accelerator',
    'The chip doubles the memory of the last model.',
  ],
  [
    8,
    'phishing-kits',
    'Phishing kits now copy bank logins in real time',
    'Researchers found the kits on 300 sites.',
  ],
  [
    8,
    'cloud-earnings',
    'Cloud company beats its revenue forecast',
    'Sales grew 30% in the quarter.',
  ],
  [
    9,
    'fab-arizona',
    'TSMC starts making 2 nm chips in Arizona',
    'The plant is the first of three on the site.',
  ],
  [
    9,
    'browser-flaw',
    'Browser maker patches a flaw that attackers used',
    'The update fixes a bug in the JavaScript engine.',
  ],
  [
    9,
    'chip-exports',
    'New rules limit exports of AI chips',
    'Companies need a license for most countries.',
  ],
  [
    9,
    'coding-agent',
    'Startup releases an agent that writes tests',
    'The agent reads the code base first.',
  ],
] as const;

const stream = new Map(
  items.map(([day, id, title, lead]) => [
    id,
    { publishedAt: new Date(Date.UTC(2026, 9, day)), text: `${title} ${lead}` },
  ]),
);

// The reader's interests: a name to show, and the sentence that the model reads.
const interests = [
  {
    name: 'Security',
    description:
      'Cybersecurity: attacks, breaches, vulnerabilities and the tools and research that defend against them.',
  },
  {
    name: 'Chips',
    description:
      'New computer chips and AI hardware, and how chips are made and supplied.',
  },
];
// A missed article costs three times as much as a false notification.
const notify = new UtilityThreshold({ falseAlarm: 1, miss: 3 });

for (const { name, description } of interests) {
  const scores = await new DecisionScorer({ model, description }).score(stream);
  for (const day of [8, 9]) {
    const from = new Date(Date.UTC(2026, 9, day));
    const to = new Date(Date.UTC(2026, 9, day + 1) - 1);
    for (const id of scores.ranked({ from, to }).slice(0, 2))
      console.log(
        name,
        from.toISOString().slice(0, 10),
        scores.probability(id).toFixed(3),
        id,
      );
  }
  console.log(name, 'notify:', scores.accepted(notify));
}
```

## What it prints

With d1-2B Q8_0 on llama.cpp b11960, it prints:

```text
Security 2026-10-08 0.905 phishing-kits
Security 2026-10-08 0.738 ransomware-hospital
Security 2026-10-09 0.758 browser-flaw
Security 2026-10-09 0.390 coding-agent
Security notify: [
  'phishing-kits',
  'browser-flaw',
  'ransomware-hospital',
  'coding-agent'
]
Chips 2026-10-08 0.888 gpu-launch
Chips 2026-10-08 0.012 cloud-earnings
Chips 2026-10-09 0.918 fab-arizona
Chips 2026-10-09 0.536 chip-exports
Chips notify: [ 'fab-arizona', 'gpu-launch', 'chip-exports' ]
```

Each interest puts its articles first on each day. The probabilities come from the model, not from the answers of the reader, so a new interest ranks well at once. `coding-agent` is the second article of Security on 2026-10-09 only because each day shows 2 articles: its probability is 0.390.

The notification accepts each article with a probability of 0.25 or more, because a miss costs three times as much as a false alarm: 1 / (1 + 3) = 0.25. Thus `coding-agent` is a false alarm. With equal costs (`falseAlarm: 1, miss: 1`), the cut is 0.5, and Security notifies only for the three security articles.

## Notes

- The scorer calls the model once for each article and each profile, one call at a time. Score new articles when they arrive, and keep the scores, if a page must not wait for the model.
- The question is "Is the main subject of this article: <description>?", word for word as research round 13 measured it. Write the description as one sentence about the subject.
- The model gave calibrated probabilities on the research slice, but the calibration changed with the answer key (research round 14). Choose the costs of a threshold for each action, and check them on your own feed.
- A refused question fails `score` with the `Experimental_DecisionRefusalError` of the AI SDK. The scorer does not give a probability in its place.
