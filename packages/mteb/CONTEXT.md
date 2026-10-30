# MTEB

To change an embedding model safely, one must know if the new model finds the right documents better or worse than the old one. MTEB (Massive Text Embedding Benchmark) is the common framework for that measurement. This package is a TypeScript port of its engine: a task gives queries, documents and the right answers, a model ranks the documents, and the metrics score the ranking.

## Language

**Task**:
A dataset with its metadata and the way to score a model on it. A retrieval task has a corpus, queries and qrels for each split.
_Avoid_: Benchmark (a named set of tasks in MTEB), dataset (for the whole task)

**Corpus**:
The documents that a retrieval task searches. Each document has an id, a text and maybe a title.
_Avoid_: Index, collection

**Query**:
The input of one search. In a retrieval task, each query has an id and a text.
_Avoid_: Question (a query can be a document)

**Qrels**:
The relevance judgments: for each query, the documents that are right and how right (1, 2, ...). The metrics compare the ranking with them.
_Avoid_: Labels, answers, ground truth

**Top ranked**:
The candidates of each query in a reranking task. The model ranks only these documents.
_Avoid_: Shortlist, candidates list

**Encoder**:
The model wrapper that gives one embedding for each input. `AiSdkEncoder` is an encoder over an AI SDK embedding model.
_Avoid_: Embedder, model (for the wrapper)

**Score**:
One number of a result, such as `ndcg_at_10`. The main score of a task is the score that MTEB ranks models by.
_Avoid_: Metric (the formula, not its value)

**Result**:
The scores of one model on one task, by split and subset, with the time of each phase. The result cache keeps one result for each model, revision and task.
_Avoid_: Run, report

**Split** and **subset**:
A split is a part of a dataset, such as `test`. A subset is a language or a part of the data, such as `default`.
_Avoid_: Partition, fold

**Table**:
The scores of one or more models in rows and columns, made by `toDataFrame`. By default, a table has a row for each task and a column for each model. The class of a table is `DataFrame`, as in pandas.
_Avoid_: Leaderboard (MTEB's web page), report
