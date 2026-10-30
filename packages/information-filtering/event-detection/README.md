# @zukhruf/event-detection

Many sources report one real occurrence, and a reader wants to see it one time. This package puts the reports of one real occurrence into one event. It finds the nearest reports of each report by the vectors of their leads. It scores each pair with a frozen logistic model on the similarity, the numbers and the publishers of the two reports. On each new publish day, it clusters the reports of the last 7 days again with group average. This kind of program is also known as event detection, or event coreference across documents.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses `node:sqlite`. The package does not start a model, a server or a process. Give it a vectors port that is ready, for example a `Collection` of [`@zukhruf/embeddings`](../embeddings).

The parameters come from research rounds #3130 and #3152, and they are valid only with EmbeddingGemma 2 ([ADR 0001](./docs/adr/0001-the-parameters-are-frozen-by-research-round-3130.md), [ADR 0005](./docs/adr/0005-research-round-3152-adds-a-same-publisher-term-and-fits-the-weights-again.md)). Give the publisher of each report when you know it.

```sh
npm install @zukhruf/event-detection @zukhruf/embeddings ai
```

```ts
import { DatabaseSync } from 'node:sqlite';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { Collection } from '@zukhruf/embeddings';
import { EventDetector, design3152b } from '@zukhruf/event-detection';

const local = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
using database = new DatabaseSync('events.sqlite');
const detector = new EventDetector({
  database,
  vectors: new Collection({
    database,
    model: local.embeddingModel(design3152b.embeddingModel),
  }),
  design: design3152b,
});

await detector.add([
  {
    id: 'a',
    title: 'Storm closes the port',
    body: 'A storm closed the port on Monday morning. Ships waited outside the harbour.',
    publishedAt: new Date('2026-10-20T08:00:00Z'),
    publisher: 'news.example',
  },
]);

detector.events({ since: new Date('2026-10-14') });
// [{ id: 0, members: ['a'], firstSeen: …, lastSeen: … }]
```

## API

- `new EventDetector({ database, vectors, design })`. The caller opens and closes `database`. The detector makes its tables `event_report` and `event_clock` in it. `vectors` is the port to the vectors of this detector only. `design` is the recipe of one research round. The vectors must come from the embedding model that `design.embeddingModel` names.
- `design3152b` is the design of research round #3152b ([ADR 0005](./docs/adr/0005-research-round-3152-adds-a-same-publisher-term-and-fits-the-weights-again.md)). `Design` is its type.
- `add(reports)` gives each new report an event. A report has an `id`, a `title`, a `body`, a `publishedAt` date and, when the caller knows it, a `publisher`. The detector gives the lead of each report that has one to `vectors.upsert`, as `{ id, text, publishedAt }`. Then it gives the reports their events, in the order of their publish dates. A report whose id the detector has already is skipped.
- `events({ since })` gives the events with a report published at or after `since`, in the order of their first report. An event has an `id` (a number), its `members` (report ids, in the order of their publish dates), `firstSeen` and `lastSeen`.
- `Vectors` is the type of the port: `upsert(documents)`, `nearest(id, { k, withinDays })`, `neighbourGraph({ from, to, k, withinDays })` and `similarity(a, b)`. A clustering asks for one neighbour graph of the window. The `Collection` of `@zukhruf/embeddings` has this shape, with no adapter.

## How it decides

1. **Lead.** The detector takes the title and the first two real sentences of the body. A URL line, a byline or a caption is not a real sentence. A URL in a real sentence goes away.
2. **Shortlist.** The 80 nearest reports, by similarity, from the reports of 7 publish days before or after.
3. **Pair score.** A logistic regression on the similarity, the numbers that both reports give, the numbers that only one report gives, and the same publisher. The numbers come from the title and the whole body. Two reports of one publisher get a lower pair score. A report without a publisher is never of the same publisher as another report.
4. **Online assignment.** A new report joins the event of its shortlist with the highest mean pair score, when it is at least 0.5. Otherwise it starts a new event.
5. **Clustering.** When the first report of a new publish day arrives, the detector clusters the window of the last publish day again, with group average. Each new cluster keeps the event id of the old event that it overlaps most ([ADR 0002](./docs/adr/0002-the-window-is-clustered-again-on-each-new-publish-day.md)).
6. **Headline-only reports.** A report with no real sentence is alone in its event, always ([ADR 0003](./docs/adr/0003-a-headline-only-report-never-joins-another-report.md)).

## Result

On the Gun Violence Corpus (509 reports, 241 incidents), which no round had seen before, round #3130 measured:

| Score                             | Detector              | Baseline              |
| --------------------------------- | --------------------- | --------------------- |
| Pair precision / recall / F0.5    | 0.918 / 0.712 / 0.868 | 0.820 / 0.144 / 0.423 |
| B-cubed precision / recall / F0.5 | 0.977 / 0.849 / 0.948 | 0.978 / 0.554 / 0.848 |

Round #3152 added the same-publisher term and fitted the weights again on the training sets (ADR 0005). The package gives these scores of the round. The anthropic-outlets scores are in-sample, because the round fitted on that set:

| Set                                     | Pair P / R / F0.5     | B-cubed P / R / F0.5  |
| --------------------------------------- | --------------------- | --------------------- |
| Gun Violence Corpus, design 3152        | 0.961 / 0.712 / 0.898 | 0.989 / 0.848 / 0.957 |
| anthropic-outlets, design 3130          | 0.306 / 0.313 / 0.307 | 0.800 / 0.865 / 0.812 |
| anthropic-outlets, design 3152 (fitted) | 0.641 / 0.257 / 0.493 | 0.938 / 0.853 / 0.919 |

On the exam set of round #3152 (deepmind-outlets, never seen before), the package gives CoNLL F0.5 0.883 against 0.818 for design 3130, and it passed the rule of the round ([ADR 0005](./docs/adr/0005-research-round-3152-adds-a-same-publisher-term-and-fits-the-weights-again.md)). A replay of the Gun Violence Corpus through the package gives the events of round #3152 ([src/conformance.test.ts](./src/conformance.test.ts)).

## Limits

Read [the limitations](./docs/limitations.md) before you use the events for a decision. In short:

- The events of the latest publish day are provisional until a report of a later publish day arrives.
- A report more than 7 publish days after its event starts a new event.
- Look-alike occurrences a few days apart can join.
- Each headline-only report is a duplicate for the reader.
- The parameters are valid only with EmbeddingGemma 2 and the vector text of round #3130.
- One clustering of a window of 1,001 reports takes 1.0 s, of 3,500 reports 9.6 s, and of 14,000 reports 175 s, through the `Collection` of `@zukhruf/embeddings`. The cost grows with the square of the window size (limitation 21).

## Decisions

Before you change a parameter, the similarity source or the model, read ADR 0001, ADR 0004, ADR 0005 and the limitations. A change needs a new research round on the evaluation sets.

Before you change a parameter, run `nx run event-detection:eval`, and run it again after the change. It scores the detector on the labelled sets and compares each score with the accepted designs ([eval/README.md](./eval/README.md)).

- [ADR 0001: The parameters are frozen by research round #3130](./docs/adr/0001-the-parameters-are-frozen-by-research-round-3130.md)
- [ADR 0002: The window is clustered again on each new publish day](./docs/adr/0002-the-window-is-clustered-again-on-each-new-publish-day.md)
- [ADR 0003: A headline-only report never joins another report](./docs/adr/0003-a-headline-only-report-never-joins-another-report.md)
- [ADR 0004: The similarity source is a port, and the parameters belong to one source](./docs/adr/0004-the-similarity-source-is-a-port-and-the-parameters-belong-to-one-source.md)
- [ADR 0005: Research round #3152 adds a same-publisher term and fits the weights again](./docs/adr/0005-research-round-3152-adds-a-same-publisher-term-and-fits-the-weights-again.md)
- [Limitations](./docs/limitations.md)
