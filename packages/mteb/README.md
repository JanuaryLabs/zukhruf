# @zukhruf/mteb

A TypeScript port of the evaluation engine of [MTEB](https://github.com/embeddings-benchmark/mteb) 2.26.28. Use it to measure if an embedding model finds the right documents, and to compare models on your own data. The scores, their names and the result files are those of MTEB.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The port and its differences from MTEB are in [docs/ported-from-mteb.md](./docs/ported-from-mteb.md).

## Use it

This package has the retrieval and reranking tasks, for text. MTEB's tasks ArguAna and SCIDOCS are ported, with their datasets from the HuggingFace Hub, and so are the models EmbeddingGemma 2 and Qwen3-Embedding with the prompts of MTEB. A task of your own keeps its dataset in a folder on disk, and its metadata names that folder as the dataset path.

```sh
npm install @zukhruf/mteb ai
```

```ts
import { join } from 'node:path';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  AbsTaskRetrieval,
  AiSdkEncoder,
  ModelMeta,
  ResultCache,
  TaskMetadata,
  evaluate,
} from '@zukhruf/mteb';

class Faq extends AbsTaskRetrieval {
  constructor() {
    super({
      metadata: new TaskMetadata({
        name: 'Faq',
        description: 'Questions and the answers that answer them.',
        dataset: { path: join(import.meta.dirname, 'faq'), revision: '1' },
        type: 'Retrieval',
        category: 't2t',
        modalities: ['text'],
        evalSplits: ['test'],
        evalLangs: ['eng-Latn'],
        mainScore: 'ndcg_at_10',
      }),
    });
  }
}

const local = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
const encoder = new AiSdkEncoder({
  model: local.embeddingModel('embeddinggemma'),
  modelMeta: ModelMeta.createEmpty({
    name: 'llama.cpp/embeddinggemma',
    revision: 'Q8_0',
  }),
});
const result = await evaluate(encoder, new Faq(), {
  cache: new ResultCache('mteb-results'),
});
console.log(result.taskResults[0]?.scores.test?.[0]?.main_score);
console.log(encoder.tokens);
```

The folder has the layout of a dataset of MTEB on the HuggingFace Hub. The front matter of its dataset card (`README.md`) names the file of each config and split:

```
faq/
├── README.md         dataset card
├── corpus.jsonl      {"_id": "a1", "text": "Reset the password from Settings."}
├── queries.jsonl     {"_id": "q1", "text": "How do I change my password?"}
└── qrels/test.jsonl  {"query-id": "q1", "corpus-id": "a1", "score": 1}
```

```yaml
---
configs:
  - config_name: default
    data_files:
      - split: test
        path: qrels/test.jsonl
  - config_name: corpus
    data_files:
      - split: corpus
        path: corpus.jsonl
  - config_name: queries
    data_files:
      - split: queries
        path: queries.jsonl
---
```

The task reads the files of the folder at each load. It does not use the revision or the cache of downloaded datasets for a folder, so a change to the qrels counts at the next load. A query that has no qrels is not in the task. To make the data in code, override `loadData` and set `this.dataset`.

`evaluate` keeps each result in the cache, in MTEB's folder layout. A second run of the same model on the same task loads the result and does not call the model; `overwriteStrategy: 'always'` runs it again. MTEB reads these files, and this package reads the files of MTEB.

Give a task `topRanked` to make it a reranking task: each query then ranks only its candidates.

## BM25 as a baseline on your own folder dataset

MTEB's BM25 baseline `mteb/baseline-bm25s` is a search model: it needs no embedding model and no server. Run it on your task first. Its score is the score that an encoder must beat.

```ts
import { ResultCache, bm25S, evaluate } from '@zukhruf/mteb';

const result = await evaluate(bm25S.loadModel(), new Faq(), {
  cache: new ResultCache('mteb-results'),
});
console.log(result.taskResults[0]?.scores.test?.[0]?.main_score);
```

`Faq` is the task of the section above. The search model splits each document (its title and its text) and each query into English words, removes the English stopwords of bm25s and stems each word with the English Snowball stemmer. Then it scores each document with BM25, as bm25s does. The scores are the scores of MTEB to the last bit.

`k1` and `b` are the keyword arguments of `loadModel`, as in MTEB. They are experiment arguments, so `bm25S.loadModel({ k1: 1.2 })` keeps its results apart from the results of the defaults (`k1` 1.5, `b` 0.75). The search model supports English only: a task in another language stops with an error.

## Compare models on MTEB's tasks

A ported model gives its encoder through `loadModel`, with the AI SDK embedding model of a server that serves its weights. The encoder adds the prompts that MTEB's numbers used, so the scores can be compared with MTEB's leaderboard.

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  ArguAna,
  ResultCache,
  SCIDOCS,
  evaluate,
  qwen3Embedding0B6,
} from '@zukhruf/mteb';

const llamaCpp = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
const encoder = qwen3Embedding0B6.loadModel({
  model: llamaCpp.embeddingModel('qwen3-embedding-0.6b'),
  quantization: 'Q8_0',
});
const result = await evaluate(encoder, [new ArguAna(), new SCIDOCS()], {
  cache: new ResultCache('mteb-results'),
});
```

Serve the model so that it takes the longest text of a task whole. llama.cpp refuses a text with more tokens than its physical batch (`-ub`, 512 by default), and MTEB does not cut the texts for EmbeddingGemma 2 or Qwen3-Embedding: start llama.cpp with `-c 8192 -b 8192 -ub 8192 --embedding`, and `--pooling last` for Qwen3-Embedding.

`examples/compare-models.ts` runs both ported models on ArguAna and SCIDOCS and prints their scores. It sends the texts to two llama.cpp servers that serve the Q8_0 weights: EmbeddingGemma 2 on port 8110 and Qwen3-Embedding on port 8111. The file has the commands that start the servers.

```sh
npx nx run mteb:compare
```

A task downloads its files once, to `~/.cache/mteb/datasets`. The keyword arguments of `loadModel`, but `model`, are experiment arguments: a quantized model keeps its results apart from the results of the full weights.

To see the scores as a bar chart for each task, run the command below. It needs [uv](https://docs.astral.sh/uv/). Python MTEB reads the result files in `~/.cache/mteb` and does not download its results repository. The command writes `~/.cache/mteb/chart.html` and prints its path.

```sh
npx nx run mteb:chart
```
