# @zukhruf/mteb

A TypeScript port of the evaluation engine of [MTEB](https://github.com/embeddings-benchmark/mteb) 2.26.28. Use it to measure if an embedding model finds the right documents, and to compare models on your own data. The scores, their names and the result files are those of MTEB.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The port and its differences from MTEB are in [docs/ported-from-mteb.md](./docs/ported-from-mteb.md).

## Use it

This package has the retrieval, reranking, pair classification and STS tasks, for text. MTEB's tasks ArguAna, SCIDOCS, SprintDuplicateQuestions and STSBenchmark are ported, with their datasets from the HuggingFace Hub, and so are the models EmbeddingGemma 2 and Qwen3-Embedding with the prompts of MTEB. A task of your own keeps its dataset in a folder on disk, and its metadata names that folder as the dataset path.

The package is private: it is not on npm. A project of this workspace names it in the dependencies of its `package.json`, with `ai`, and npm links the workspace package:

```json
{ "dependencies": { "@zukhruf/mteb": "*", "ai": "^7.0.154" } }
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

## Hybrid search: BM25 with an embedding model

BM25 finds the documents that share words with the query. An encoder finds the documents with a similar meaning. A hybrid search uses both and fuses their scores. `HybridSearch` is MTEB's hybrid search. Give it two or more models: an encoder or a search model.

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  HybridSearch,
  ResultCache,
  bm25S,
  evaluate,
  qwen3Embedding0B6,
} from '@zukhruf/mteb';

const llamaCpp = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
const hybrid = new HybridSearch({
  models: [
    bm25S.loadModel(),
    qwen3Embedding0B6.loadModel({
      model: llamaCpp.embeddingModel('qwen3-embedding-0.6b'),
    }),
  ],
  fusionStrategy: 'rrf',
});
const result = await evaluate(hybrid, new Faq(), {
  cache: new ResultCache('mteb-results'),
});
```

Each model finds the best `subModelTopK` documents of each query (100 by default, or `topK` of the search when it is greater). Then the fusion gives each document one score:

- `'rrf'` (the default): Reciprocal Rank Fusion. Each model adds `weight / (rrfK + rank)`. `rrfK` is 60 by default.
- `'dbsf'`: Distribution-Based Score Fusion. Each model places its scores between the mean minus 3 standard deviations and the mean plus 3 standard deviations, and clips them to 0 to 1.
- `'rsf'`: Relative Score Fusion. Each model places its scores between its lowest and its highest score.
- A function of your own, with the type `FusionFunction`.

`weights` gives one weight to each model. By default, each model has the same weight. The fused scores are the scores of MTEB to the last bit.

The hybrid has the name `mteb/baseline-hybrid-<fusion>-<names>`. The names are the last parts of the model names, so the hybrid above is `mteb/baseline-hybrid-rrf-baseline-bm25s-Qwen3-Embedding-0.6B`. The result cache keeps the result of the hybrid under this name, and a table shows it in a column with this name.

The settings of a hybrid that are not the defaults are its experiment arguments:

- `sub_models`: the experiment name of each model, or `None` for a model without one. The hybrid has this argument when one or more models have an experiment name.
- `weights`: the weights, when you give them.
- `rrf_k`: `rrfK`, when the fusion is `'rrf'` and `rrfK` is not 60.
- `sub_model_top_k`: `subModelTopK`, when you give it.

Thus the hybrid of `bm25S.loadModel()` and `bm25S.loadModel({ k1: 1.2 })` has the experiment name `sub_models_[None,k1_1.2]`, and its result does not replace the result of the hybrid of two default BM25 models. A hybrid with all the default settings has no experiment arguments, so its name and its result folder are those of MTEB. MTEB gives a hybrid no experiment arguments.

## Pair classification

In a pair classification task, each row of a split is a pair: two texts and a label. The label is 1 when the texts are similar, and 0 when they are not. The task gives each pair five scores: the cosine similarity, the Euclidean distance, the Manhattan distance, the similarity of the model and the dot product. For each score, it finds the threshold with the best accuracy and the threshold with the best F1, and it calculates the average precision. The main score of MTEB's pair classification tasks is `max_ap`, the best average precision of the five scores.

```ts
import { SprintDuplicateQuestionsPC, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new SprintDuplicateQuestionsPC());
```

A task of your own extends `AbsTaskPairClassification`. Its dataset has the columns `sentence1`, `sentence2` and `labels`. For other column names, set `input1ColumnName`, `input2ColumnName` and `labelColumnName`, or change the names with `renameColumn` in `datasetTransform`.

## STS

In an STS (semantic textual similarity) task, each row of a split is a pair: two texts and a gold score. The gold score tells how similar the texts are, from `minScore` to `maxScore` (by default 0 to 5). The task gives each pair four scores: the cosine similarity, the negative Manhattan distance, the negative Euclidean distance and the similarity of the model. For each score, it calculates the Pearson and the Spearman correlation with the gold scores. The main score of MTEB's STS tasks is `cosine_spearman`.

```ts
import { STSBenchmarkSTS, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new STSBenchmarkSTS());
```

A task of your own extends `AbsTaskSTS`. Its dataset has the columns `sentence1`, `sentence2` and `score`. For other text columns, set `columnNames`. For another range of gold scores, set `minScore` and `maxScore`.

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

## Compare the results in a table

The result cache keeps the results of each model. `toDataFrame` puts them in a table, as MTEB's `to_dataframe` does: a row for each task and a column for each model. `getAggregatedScores` gives the mean score of each model over its tasks (`Mean(Task)`) and over the task types (`Mean(TaskType)`).

```ts
import { ArguAna, ResultCache, SCIDOCS } from '@zukhruf/mteb';

const results = new ResultCache('mteb-results')
  .loadResults({ includeRemote: false, loadExperiments: 'match_name' })
  .selectTasks([new ArguAna(), new SCIDOCS()]);
console.log(results.toDataFrame().toString());
console.log(results.getAggregatedScores());
```

```
task_name  is_public  Qwen/Qwen3-Embedding-0.6B  google/embeddinggemma-2
ArguAna    True                        0.694170                 0.597370
SCIDOCS    True                        0.243560                 0.180830
```

`aggregationLevel` gives a row for each subset, split, task or language. `format: 'long'` gives a row for each model and a `score` column. `includeModelRevision` gives a column for each model and revision. `getAggregatedScores` reads the task type of each result, so give the results their tasks with `selectTasks` first.

By default, a table averages the experiments of one model with its default run, as MTEB does: the results of a quantized model and of its full weights share one column. `includeExperiments: true` gives a column for each experiment of a model. See [Compare a change with its baseline](#compare-a-change-with-its-baseline).

`examples/table.ts` prints the table and the means of the results in `~/.cache/mteb`. An argument names another cache folder.

```sh
npx nx run mteb:table
```

To see the scores as a bar chart for each task, run the command below. It needs [uv](https://docs.astral.sh/uv/). Python MTEB reads the result files in `~/.cache/mteb` and does not download its results repository. The command writes `~/.cache/mteb/chart.html` and prints its path.

```sh
npx nx run mteb:chart
```

## Compare a change with its baseline

A change of a setting, such as `k1` of BM25 or the weights of a hybrid, is an experiment of a model. The default run of the model is the baseline. Evaluate both with the same result cache. Then load the results with their experiments, and make a table with `includeExperiments: true`:

```ts
import { ResultCache, bm25S, evaluate } from '@zukhruf/mteb';

const cache = new ResultCache('mteb-results');
await evaluate(bm25S.loadModel(), new Faq(), { cache });
await evaluate(bm25S.loadModel({ k1: 1.2 }), new Faq(), { cache });

const results = cache
  .loadResults({ includeRemote: false, loadExperiments: 'match_name' })
  .selectTasks([new Faq()]);
console.log(results.toDataFrame({ includeExperiments: true }).toString());
console.log(results.getAggregatedScores({ includeExperiments: true }));
```

The wide table has a second column level, `experiment`, below the model name. The experiment of the default run is `""`. The long table has an `experiment` column. `getAggregatedScores({ includeExperiments: true })` gives the means of each model by experiment: `{ [model]: { [experiment]: { 'Mean(Task)', 'Mean(TaskType)' } } }`. The column of each experiment has the scores that MTEB gives for the results of that experiment alone, but for the last bit of a mean. MTEB has no such option. Without it, the table and the means are those of MTEB.

`nx run mteb:table` prints the table and the means with the experiments.

A table does not say if a difference is more than chance. See [Is the change real?](#is-the-change-real).

## Is the change real?

A table shows that a change scores higher or lower than its baseline. It does not show if the difference is more than chance: with other queries, the order can be the reverse. `pairedBootstrapTest` answers that question. MTEB has no such test.

The test compares the score of each query, so it needs the predictions of each model. Give `evaluate` a `predictionFolder`, one folder for each model, because the file name is the name of the task. Use `overwriteStrategy: 'always'`: `evaluate` writes no predictions when it reads a result from the cache. Then `perQueryScores` gives the main score of each query, as the evaluation of the task calculates it.

```ts
import {
  bm25S,
  evaluate,
  pairedBootstrapTest,
  perQueryScores,
} from '@zukhruf/mteb';

const task = new Faq();
await evaluate(bm25S.loadModel(), task, {
  predictionFolder: 'predictions/baseline',
  overwriteStrategy: 'always',
});
await evaluate(bm25S.loadModel({ k1: 1.2, b: 0.5 }), task, {
  predictionFolder: 'predictions/change',
  overwriteStrategy: 'always',
});

const verdict = pairedBootstrapTest(
  await perQueryScores(task, 'predictions/baseline'),
  await perQueryScores(task, 'predictions/change'),
);
console.log(verdict);
```

```
{
  result: 'inconclusive',
  observed: -0.0004332032713899203,
  low: -0.013840414128031475,
  high: 0.01024766985882517,
  p: 0.98,
  queries: 20,
  replicates: 2000,
  seed: 31957
}
```

`observed` is the mean of (change - baseline) over the queries. `low` and `high` are the bounds of its 95% interval. The test draws as many queries as there are, with replacement, 2000 times, and takes the mean difference of each draw (a paired bootstrap test, Efron and Tibshirani 1993). The result is `better` when `low` is above 0, `worse` when `high` is below 0, and `inconclusive` when the interval contains 0. The output above is for the 20 queries of the BM25 fixture (`src/models/model-implementations/fixtures/bm25/`), not for a real task.

`p` is the two-sided p-value of the same 2000 means (Efron and Tibshirani 1993). It is two times the smaller share of the means that are at or below 0, or at or above 0, and it is at most 1. Thus `p` is below 0.05 when the interval does not contain 0, but for the interpolation of the interval bounds.

When you compare more than one change, some changes are `better` or `worse` by chance. `holm` corrects the p-values of all the comparisons together (Holm 1979). A comparison is significant at the 5% level when its corrected p-value is 0.05 or less. `holm` gives the values of `multipletests(pvals, method="holm")` of statsmodels 0.15.0, in the order of the p-values that you give it:

```ts
const verdicts = changes.map((change) => pairedBootstrapTest(baseline, change));
const corrected = holm(verdicts.map((verdict) => verdict.p));
```

The seed is fixed, so the same scores give the same verdict. `replicates` and `seed` are options. `perQueryScores` takes `split`, `subset` and `score` options; a score must have a value for each query, such as `ndcg_at_10` or `recall_at_100`. The test refuses a baseline and a change with different queries.

With few queries, the interval is wide, and most changes are `inconclusive`. Add queries to the task to make the test stronger. To try more changes on the same queries does not help.
