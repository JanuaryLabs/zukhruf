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
Two inputs and a label in a pair classification task. The label is 1 when the two inputs are similar, and 0 when they are not. The task gives each pair five scores and measures how well a threshold on each score separates the labels. In an STS task, a pair has two inputs and a gold score. In a reranking task, a pair is a query and one of its top ranked documents, and a cross-encoder gives it a score.
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

**Label set**:
The labels of an input in a multilabel classification task: a list of zero or more labels. The classifier predicts a label set for each input of the evaluation split.
_Avoid_: Tags, multi-label target

**Value**:
The number of an input in a regression task, such as the citations of an article. The task trains a linear model on the embeddings of the training inputs. Then the model predicts the value of each input of the evaluation split, and the scores compare the predictions with the values.
_Avoid_: Label, target, score (a score is a number of a result)

**Encoder**:
The model wrapper that gives one embedding for each input. `AiSdkEncoder` is an encoder over an AI SDK embedding model.
_Avoid_: Embedder, model (for the wrapper)

**Cross-encoder**:
The model wrapper that gives one score for each pair of a query and a document, from the two texts together. A cross-encoder runs only on a reranking task: it scores the top ranked documents of each query. `AiSdkReranker` is a cross-encoder over an AI SDK reranking model.
_Avoid_: Reranker (for the wrapper)

**Search model**:
The model that indexes a corpus and gives the score of each document that it finds for each query (`SearchProtocol`, MTEB's search protocol). MTEB's BM25 baseline `mteb/baseline-bm25s` is a search model with no embedding model. `SearchEncoderWrapper` makes an encoder a search model, and `SearchCrossEncoderWrapper` makes a cross-encoder a search model for reranking.
_Avoid_: Retriever, search engine

**Hybrid search**:
The search model that runs two or more models on the same queries and fuses the scores of each document (`HybridSearch`, MTEB's `mteb/models/hybrid_wrappers.py`). Each model is an encoder, a cross-encoder or a search model. `fusionStrategy` gives the fusion: Reciprocal Rank Fusion (`rrf`, the default), Distribution-Based Score Fusion (`dbsf`), Relative Score Fusion (`rsf`) or a `FusionFunction` of your own.
_Avoid_: Ensemble, fusion (the way that it combines the scores)

**CO₂ emissions**:
The kg CO₂eq of the electricity that the machine used for one task run, as codecarbon estimates it: the energy of the RAM and the CPU (and the GPU of an Apple chip) multiplied by the carbon intensity of the grid. `kgCo2Emissions` of a task result holds it.
_Avoid_: Carbon footprint, energy (the energy is in kWh)

**Embedding cache**:
The folder that `CachedEmbeddingWrapper` keeps the embedding of each text in, for one encoder. An encoder embeds only the texts that the folder does not hold.
_Avoid_: Result cache (it keeps scores), vector store

**Result cache**:
The folder that `ResultCache` keeps the results in: `results/<model>/<revision>/<task>.json`, and `experiments/<experimentName>/` in the revision folder for the results of an experiment. The default folder is `~/.cache/mteb`. `overwriteStrategy` of `evaluate` decides when `evaluate` runs a task again instead of reading its result from the result cache.
_Avoid_: Embedding cache (it keeps embeddings), results folder

**Predictions**:
The file `<task name>_predictions.json` that a task writes in the `predictionFolder` of `evaluate`: what the model gives for each subset and split, such as the score of each document for each query in a retrieval task. `perQueryScores` and `Report.from` read it to give the score of each query. `evaluate` writes no predictions when it reads a result from the result cache.
_Avoid_: Outputs, run file

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

**Experiment**:
A model with experiment arguments: the keyword arguments that change its settings, such as `k1` of BM25 or the weights of a hybrid. `experimentKwargs` of `ModelMeta` holds them, as MTEB's `experiment_kwargs` does. `experimentName` makes them a folder name, so the result cache keeps the results of an experiment in `experiments/<experimentName>`, apart from the results of the model with its defaults.
_Avoid_: Ablation (one kind of experiment), configuration

**Baseline**:
The model that a change must beat, such as BM25 or a model with its defaults. In a report, the baseline is one of the models (`baseline` of `ReportOptions`), and by default each other model is a change against it. Not from MTEB.
_Avoid_: Control, reference model

**Change**:
The model that a comparison tests against its baseline, such as an experiment of the model or another model. A `Comparison` is the pair `[baseline, change]`. Not from MTEB.
_Avoid_: Candidate (a document of top ranked), treatment

**Verdict**:
The answer of a paired bootstrap test on a change and its baseline for one score: `better`, `worse` or `inconclusive`, with the mean difference over the queries, its 95% interval and the p-value. `pairedBootstrapTest` gives a `ChangeVerdict`. A `Verdict` of a report adds the baseline, the change, the score and the p-value that decides the result. A difference counts when that p-value is at most 0.05, as a level-0.05 test rejects (#6299). Not from MTEB.
_Avoid_: Decision, outcome, significance

**Report**:
The results of one task for each split, with the verdict of each comparison and the score of each query: one page and two tables (scores and verdicts), made by `Report.from`. Not from MTEB.
_Avoid_: Dashboard, summary, leaderboard
