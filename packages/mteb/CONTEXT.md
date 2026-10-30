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

**Pair**:
Two inputs and a label in a pair classification task. The label is 1 when the two inputs are similar, and 0 when they are not. The task gives each pair five scores and measures how well a threshold on each score separates the labels. In an STS task, a pair has two inputs and a gold score.
_Avoid_: Sample, example, couple

**Gold score**:
The similarity of the two inputs of a pair in an STS task, from human annotators. It is a number from the minimum score to the maximum score of the task (0 to 5 for STSBenchmark). The task scales each gold score to 0 to 1, and calculates the Pearson and Spearman correlations of the gold scores with each score of the pairs.
_Avoid_: Label, target, ground truth

**Cluster**:
A group of inputs that k-means makes in a clustering task. Each input has a label, or a list of labels for the levels of a hierarchy. The V-measure compares the clusters with the labels. It is 1 when each cluster holds the inputs of one label only and each label is in one cluster only.
_Avoid_: Group, class (the label of an input)

**Label**:
The class of an input in a classification task: an int or a string. The task trains a classifier on the embeddings of some inputs of each label. Then the classifier predicts the label of each input of the evaluation split, and the metrics compare the predictions with the labels.
_Avoid_: Category, target, ground truth

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
The scores of one or more models in rows and columns, made by `toDataFrame`. By default, a table has a row for each task and a column for each model, and it shows the main score. A table can show other scores side by side. The class of a table is `DataFrame`, as in pandas. A table can be written as Markdown, CSV or LaTeX.
_Avoid_: Leaderboard (MTEB's web page), report
