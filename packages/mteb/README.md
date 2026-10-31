# @zukhruf/mteb

A TypeScript port of the evaluation engine of [MTEB](https://github.com/embeddings-benchmark/mteb) 2.26.28. Use it to measure if an embedding model finds the right documents, and to compare models on your own data. The scores, their names and the result files are those of MTEB.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The port and its differences from MTEB are in [docs/ported-from-mteb.md](./docs/ported-from-mteb.md).

## Use it

This package has the retrieval, reranking, pair classification, STS, clustering, classification, multilabel classification and regression tasks, for text. MTEB's tasks ArguAna, SCIDOCS, SprintDuplicateQuestions, STSBenchmark, BiorxivClusteringS2S, BiorxivClusteringS2S.v2, Banking77Classification, Banking77Classification.v2, KorHateSpeechMLClassification, RuSciBenchCitedCountRegression and RuSciBenchYearPublRegression are ported, with their datasets from the HuggingFace Hub, and so are the models EmbeddingGemma 2 and Qwen3-Embedding with the prompts of MTEB, and the cross-encoders BGE-Reranker-v2-m3, Jina-Reranker-v2, the ms-marco cross-encoders and Qwen3-Reranker. A task of your own keeps its dataset in a folder on disk, and its metadata names that folder as the dataset path.

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

`Faq` is the task of the section above. The search model reads the language of the task from its metadata, and reads a task with more than one language as English. It splits each document (its title and its text) and each query into words, removes the stopwords of the language and stems each word with the Snowball stemmer of the language. Then it scores each document with BM25, as bm25s does. The scores are the scores of MTEB to the last bit.

bm25s has stopwords for English, German, Dutch, French, Spanish, Portuguese, Italian, Russian, Swedish, Norwegian and Chinese. MTEB gives a stemmer to the languages of 30 Snowball algorithms, such as Finnish, Arabic and Tamil. A language without stopwords gets the stopwords from document frequencies: each stem that is in 90% or more of the documents. A language that MTEB does not list, such as Polish, gets no stemmer and only these stopwords. Chinese, Japanese, Korean, Thai, Khmer, Burmese, Tibetan and Lao get the `char` tokenizer: each character of the NFKC form in lower case is a token, but the space. Chinese gets the Chinese stopwords, and the other languages get the stopwords from document frequencies.

`stopwords`, `stemmer_language`, `freq_threshold`, `tokenizer`, `k1`, `b`, `delta` and `method` are the keyword arguments of `loadModel`, as in MTEB. `stopwords` is the key of a bm25s list (`'en'`, `'de'`, `'nl'`, `'fr'`, `'es'`, `'pt'`, `'it'`, `'ru'`, `'sv'`, `'no'` or `'zh'`). `stemmer_language` is the name of a Snowball algorithm of PyStemmer, such as `'polish'`. Each one replaces the setting of the language of the task. `freq_threshold` is the share of the documents that makes a stem a stopword, when the stopwords come from document frequencies. 0 turns these stopwords off. `tokenizer` is a function from a text to its tokens. With a function, the search model does not read the language: the tokens get no stemmer, and they get the stopwords from document frequencies unless `stopwords` names a list. A function cannot name an experiment, so `experimentName` throws, as in MTEB. `method` is the BM25 variant of bm25s: `'robertson'`, `'lucene'`, `'atire'`, `'bm25l'` or `'bm25+'`. `delta` is used by `'bm25l'` and `'bm25+'` only. The keyword arguments are experiment arguments, so `bm25S.loadModel({ freq_threshold: 0 })` keeps its results in `experiments/freq_threshold_0`, apart from the results of the defaults (`freq_threshold` 0.9, `k1` 1.5, `b` 0.75, `delta` 0.5, `method` `'lucene'`). They keep MTEB's names, so the folder is the folder of MTEB.

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

## Keep embeddings between runs

An encoder that embeds a large corpus again for each run is slow and costs money. `CachedEmbeddingWrapper` is MTEB's embedding cache. It wraps an encoder and keeps the embedding of each text in a folder. On the next call, the encoder embeds only the texts that the folder does not hold.

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import {
  CachedEmbeddingWrapper,
  ResultCache,
  evaluate,
  qwen3Embedding0B6,
} from '@zukhruf/mteb';

const llamaCpp = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
using encoder = new CachedEmbeddingWrapper(
  qwen3Embedding0B6.loadModel({
    model: llamaCpp.embeddingModel('qwen3-embedding-0.6b'),
  }),
  'mteb-embeddings/Qwen3-Embedding-0.6B',
);
const result = await evaluate(encoder, new Faq(), {
  cache: new ResultCache('mteb-results'),
});
```

The wrapper has the metadata of its encoder, so the result cache keeps the result under the name of the encoder.

The folder of a task is `<folder>/<task name>`. A call with a prompt type adds `query` or `document`. A precision or the experiment arguments of the encoder add `experiments/<experiment name>` after the task name. The name of the encoder is not in the path:

- Give each encoder its own folder. Two encoders with the same dimension in one folder read the embeddings of each other, and nothing stops them.
- Use a folder in one process at a time. The cache has no lock, as in MTEB.

The wrapper keeps the embeddings only within a task. It uses them again for other splits and subsets, for other runs, and for other searches with the same encoder, such as a hybrid search.

The result cache and the embedding cache do not overlap. The result cache keeps the scores of a task, and `evaluate` does not run a task that has a result. The embedding cache keeps an embedding for each text, so it helps only a task that runs.

The files of a folder are those of MTEB's `NumpyCache`: `vectors.npy` (float32 rows with no header), `index.json` and `dimension`. MTEB reads a folder that this package wrote, and this package reads a folder that MTEB wrote. `vectors.npy` starts with room for 100,000 embeddings: a sparse file of 400 MB at 1024 dimensions. A copy that is not sparse uses all of that space on the disk.

MTEB gives a document its title twice, and a query its instruction twice, when the text is not in the folder yet. Thus in MTEB, a run with the cache can give other scores than a run without it. This package embeds the texts of a run without the cache. A folder that MTEB filled holds those embeddings, and the wrapper reads them as they are.

## Track the CO₂ emissions of a run

A benchmark run uses electricity, and the cost of a model choice can include its emissions. MTEB measures them with codecarbon, and this package ports that CO₂ tracker. With `co2Tracker: true`, `evaluate` tracks each task, and the result of the task holds `kgCo2Emissions`, in kg CO₂eq.

```ts
import { ResultCache, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new Faq(), {
  cache: new ResultCache('mteb-results'),
  co2Tracker: true,
});
console.log(result.taskResults[0]?.kgCo2Emissions);
```

The tracker measures the machine that runs `evaluate`. When the encoder calls a model on another machine, the number does not include that machine.

The emissions are the energy of the machine multiplied by the carbon intensity of its electricity grid:

- The RAM uses 3 W for each 8 GB of the machine.
- On Linux, the CPU energy comes from the RAPL counters, when the process can read them. Most kernels let only root read them.
- On a Mac, the CPU and GPU power come from `powermetrics`, when `sudo` runs it without a password. The tracker runs `sudo -n`, so it never asks for a password. `powermetrics` writes `powermetrics_log.txt` into the current folder.
- Else the CPU uses half of its TDP, from codecarbon's table of CPUs, or 42.5 W when the table does not know the CPU. Then the emissions are the run time multiplied by a constant.
- The grid comes from the cloud metadata server of GCP, or from the location of the IP address (get.geojs.io, then ip-api.com). When the network fails, the grid is that of Quebec, Canada. Each task waits for these requests, up to about 4.5 seconds when the network is down.

Only one tracker can run on a machine at a time. It holds the file `.codecarbon.lock` in the temporary folder of the system, as codecarbon does, so a Python codecarbon run also stops it. When another run holds the file, the task runs, and then `evaluate` throws a `TypeError` with MTEB's message. The cause of the error names the file. A process that was killed leaves the file: delete it. On a resumed task, the new emissions add to the emissions of the cached result.

## Reranking with a cross-encoder

A cross-encoder gets the query and one document at the same time, and gives the pair one score. It does not give embeddings, so it cannot search a full corpus. It reranks the top ranked documents of each query: the documents that a first search found. MTEB runs a cross-encoder only on a reranking task, and so does this package.

First, make a reranking task from the predictions of a first search, such as BM25. `convertToReranking` reads the predictions file and keeps the `topK` best documents of each query as the top ranked documents:

```ts
import { bm25S, evaluate } from '@zukhruf/mteb';

await evaluate(bm25S.loadModel(), new Faq(), {
  cache: null,
  predictionFolder: 'predictions/bm25',
});
const reranking = await new Faq().convertToReranking('predictions/bm25', 20);
```

Then give `evaluate` a cross-encoder. `AiSdkReranker` sends each pair to an AI SDK reranking model, such as a llama.cpp server with `--rerank`. Install `@ai-sdk/cohere`: llama.cpp answers in the format of the Cohere API.

```ts
import { createCohere } from '@ai-sdk/cohere';

import {
  AiSdkReranker,
  ResultCache,
  evaluate,
  noRerankingBaseline,
} from '@zukhruf/mteb';

const llamaCpp = createCohere({ baseURL: 'http://127.0.0.1:8080/v1' });
const cache = new ResultCache('mteb-results');
const reranker = new AiSdkReranker({
  model: llamaCpp.reranking('bge-reranker-v2-m3'),
});
await evaluate(noRerankingBaseline.loadModel(), reranking, { cache });
await evaluate(reranker, reranking, { cache });
```

`noRerankingBaseline` keeps the order of the first search. Its score is the score that a reranker must beat.

MTEB's cross-encoders have their metadata here: `bgeRerankerV2M3`, `jinaRerankerMultilingual`, the five ms-marco cross-encoders (such as `msMarcoMinilmL6V2`) and `qwen3Reranker0B6`, `qwen3Reranker4B` and `qwen3Reranker8B`. `loadModel` takes the AI SDK reranking model of a server that serves the weights, and sends the texts that MTEB's model scores:

```ts
import { bgeRerankerV2M3 } from '@zukhruf/mteb';

const bge = bgeRerankerV2M3.loadModel({
  model: llamaCpp.reranking('bge-reranker-v2-m3'),
});
await evaluate(bge, reranking, { cache });
```

The server applies the activation and the precision of the model, so the scores are near the scores of MTEB, not equal to them. BGE and Jina score the query without its instruction, as in MTEB. Qwen3-Reranker sends the query with its instruction. MTEB also gives Qwen3-Reranker the instruction in its own prompt, which a reranking server cannot take, so its scores differ more.

The cross-encoder sends one pair in each call, and it sends the calls one after the other, as MTEB does. A server that gets calls at the same time scores them in one batch, and a batch changes the scores. Thus a task with 100 queries and 20 top ranked documents for each query makes 2,000 calls. The cross-encoder gives every top ranked document a score, so `topK` of the task has no effect. A response without exactly one score stops the evaluation with an error.

`HybridSearch` takes a cross-encoder as one of its models.

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

## Clustering

In a clustering task, each row of a split is a text and its label. The task embeds a sample of the texts. Then it clusters the embeddings with k-means (`MiniBatchKMeans` of scikit-learn), and compares the clusters with the labels. The V-measure is 1 when each cluster holds the texts of one label only and each label is in one cluster only. `AbsTaskClustering` (MTEB's v2 tasks) embeds 4% of the split, and clusters 10 samples of 16384 embeddings. Its main score is `v_measure`, the mean V-measure of the 10 samples. `ami` is the mean adjusted mutual information. When a text has a list of labels, one for each level of a hierarchy, the task scores each level.

```ts
import { BiorxivClusteringS2SFast, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new BiorxivClusteringS2SFast());
```

A task of your own extends `AbsTaskClustering`. Its dataset has the columns `sentences` and `labels`. For other columns, set `inputColumnName` and `labelColumnName`. To embed another part of the split, set `maxFractionOfDocumentsToEmbed` or `maxDocumentToEmbed`. `nClusters` sets the number of samples to cluster, and `maxDocumentsPerCluster` the size of each sample. `AbsTaskClusteringLegacy` is MTEB's older form: each row is a set of texts with a list of labels, and the task clusters each set.

## Classification

In a classification task, each row of a split is a text and its label. The task trains a classifier (`LogisticRegression` of scikit-learn) on the embeddings of 8 training rows of each label. Then the classifier predicts the label of each row of the evaluation split. The task does this 10 times, with other training rows each time, and gives the mean of the scores. The scores are the accuracy, and the F1, precision and recall with the macro and the weighted average. For two labels, the task also gives the average precision (`ap`). The main score of Banking77Classification is `accuracy`.

```ts
import { Banking77ClassificationV2, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new Banking77ClassificationV2());
```

A task of your own extends `AbsTaskClassification`. Its dataset has a `train` split and the columns `text` and `label`. For other columns, set `inputColumnName` and `labelColumnName`. For another training split, set `trainSplit`. `samplesPerLabel` sets the number of training rows of each label, and `nExperiments` the number of experiments.

## Multilabel classification

In a multilabel classification task, each row of a split is a text and its label set: a list of zero or more labels. The task selects training rows in a random order until each label has 8 rows. Then it trains a classifier (`KNeighborsClassifier` of scikit-learn, with 5 neighbours) on their embeddings, and the classifier predicts the label set of each row of the evaluation split. An evaluation split of more than 3000 rows keeps 3000 rows, with the same mix of labels. The task does this 10 times, with other training rows each time, and gives the mean of the scores. The scores are the accuracy (the share of rows with all labels right), the label ranking average precision (`lrap`), the F1 with the macro average, and the Hamming score (`hamming`: the labels that the prediction and the row share, divided by the labels that one of them has). The main score of KorHateSpeechMLClassification is `accuracy`.

```ts
import { KorHateSpeechMLClassification, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new KorHateSpeechMLClassification());
```

A task of your own extends `AbsTaskMultilabelClassification`. Its dataset has a `train` split, a column `text` and a column `label` with a list of labels in each row. The fields of a classification task set the columns, the training split, the rows of each label and the number of experiments. `maxEvalSamples` sets the largest evaluation split, and `null` keeps the whole split.

## Regression

In a regression task, each row of a split is a text and its value: a number. The task trains a linear model (`LinearRegression` of scikit-learn) on the embeddings of the training rows. Then the model predicts the value of each row of the evaluation split. When the training split has more than 2048 rows, the task keeps 2048 of them, with the same share of each tenth of the values. The task does this 10 times, with other training rows each time, and gives the mean of the scores. The scores are the mean squared error (`mse`), the mean absolute error (`mae`), the coefficient of determination (`r2`), Kendall's tau (`kendalltau`) and the square root of `mse` (`rmse`). The main score of the RuSciBench tasks is `kendalltau`.

```ts
import { RuSciBenchCitedCountRegression, evaluate } from '@zukhruf/mteb';

const result = await evaluate(encoder, new RuSciBenchCitedCountRegression());
```

A task of your own extends `AbsTaskRegression`. Its dataset has a `train` split and the columns `text` and `value`. The fields of a classification task set the columns, the training split and the number of experiments. `nSamples` sets the largest number of training rows of an experiment.

The linear model can predict values that differ from MTEB's in their last float32 bits, so `mse`, `mae`, `r2` and `rmse` can differ from MTEB's in their last bits (by less than 1e-5 of their size on the data of the tests). When the embeddings have as many dimensions as the training split has rows, or more, the model of MTEB depends on the LAPACK library, and the scores of this package can differ more. See [docs/ported-from-mteb.md](./docs/ported-from-mteb.md).

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

A table shows the main score of each task. `scores` gives a table of other scores, side by side, in the order that you give them. A long table has a column for each score, with the name of the score, in place of `score`. A wide table has a column level for each score, above the models. Each score has the table that MTEB makes when that score is the main score.

`toString` prints a table as aligned text. To write a table to a file, use `toMarkdown`, `toCsv` or `toLatex`. Each one gives the text that pandas writes with `to_markdown`, `to_csv` or `to_latex` and `index=False`. pandas does not escape LaTeX characters such as `_`, so pass `escape: true` to `toLatex` for names that have them.

```ts
import { writeFileSync } from 'node:fs';

const table = results.toDataFrame({
  aggregationLevel: 'split',
  format: 'long',
  scores: ['ndcg_at_10', 'recall_at_10', 'mrr_at_10'],
});
writeFileSync('scores.md', table.toMarkdown());
writeFileSync('scores.csv', table.toCsv());
writeFileSync('scores.tex', table.toLatex({ escape: true }));
```

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

## Report a task

A table and a verdict each answer one question. A report puts the results of a task, the verdicts and the score of each query on one page, for each split. It is not from MTEB: MTEB has its leaderboard, which compares models over many tasks.

`Report.from` reads what `evaluate` saved: the results in the result cache and the predictions of each model. Give it the same `predictionFolder` function that you gave `evaluate`, and the model that the other models must beat (`baseline`).

```ts
import { writeFileSync } from 'node:fs';

import { type MTEBModels, ResultCache, bm25S, evaluate } from '@zukhruf/mteb';
import { Report } from '@zukhruf/mteb/report';

const task = new Faq();
const cache = new ResultCache('mteb-results');
const baseline = bm25S.loadModel();
const change = bm25S.loadModel({ k1: 1.2, b: 0.5 });
const predictionFolder = (model: MTEBModels) =>
  `predictions/${model.mtebModelMeta.modelNameAsPath()}${model.mtebModelMeta.experimentName ?? ''}`;
for (const model of [baseline, change])
  await evaluate(model, task, {
    cache,
    predictionFolder: predictionFolder(model),
    overwriteStrategy: 'always',
  });

const report = await Report.from({
  task,
  models: [baseline, change],
  cache,
  predictionFolder,
  baseline,
});
writeFileSync('report.html', report.toHtml());
writeFileSync('report.md', report.toMarkdown());
writeFileSync('scores.csv', report.scores.toCsv());
writeFileSync('verdicts.tex', report.verdicts.toLatex({ escape: true }));
```

`toHtml` gives one page. A switch at the top selects the split. For each split, the page shows the models ranked by the main score, the verdict of each comparison, the recall at each cut-off next to the recall of a perfect ranking, the main score of each query, a table of the scores, and how the models were tested. Each section title is a claim that comes from the numbers.

By default, the report compares each model with the baseline on the main score of the task. When the main score has no value for each query (MRR, for example), the queries and the verdicts use nDCG@10. `comparisons` gives other pairs, as `[baseline, change]`, and `tested` gives other scores. `holm` corrects the p-values of all the comparisons together. `primary` names one comparison and one score that you chose before you saw the scores: the report tests it alone and corrects the others. A difference counts when its deciding p-value (the corrected p-value, or the p-value of the primary comparison) is below 0.05.

`scores` and `verdicts` are tables (`DataFrame`), so `toCsv`, `toMarkdown` and `toLatex` write them. A model without predictions gives an error that names its folder: `evaluate` writes no predictions when it reads a result from the cache. Predictions of another run give an error too: the main score of their queries must average to the score in the result, as the evaluation calculates it.

The table of all scores also shows how long `evaluate` took for each model, as its result records it. That time counts loading the data of the task, which `evaluate` does for each model unless the task was loaded before it ran. To see a report without a task of your own, run the example. It evaluates BM25 and BM25 with `k1` 1.2 and `b` 0.5 on the BM25 fixture, writes the report to a new temporary folder, and prints the path of the page:

```sh
npx nx run mteb:report
```
