# Ported from MTEB

This package is a port of the evaluation engine of [MTEB](https://github.com/embeddings-benchmark/mteb) 2.26.28 (Apache-2.0, see `NOTICE`). Each TypeScript module has one Python source module. When MTEB changes, compare the source module at the new tag with the tag on the left, and make the same change here.

The first step ports the core and the retrieval and reranking tasks, for text. The other task types (classification, clustering, STS, pair classification, regression, zero-shot) and the other modalities (image, audio, video) come later. The types keep the modality fields of MTEB, so that a later step adds a modality without a change of design.

## Modules

| MTEB 2.26.28 (`mteb/`)                                                     | This package (`src/`)                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `types/_encoder_io.py`                                                     | `types/encoder-io.ts`                                   |
| `types/_result.py`                                                         | `types/result.ts`                                       |
| `types/_metadata.py`                                                       | `types/metadata.ts`                                     |
| `timing.py`                                                                | `timing.ts`                                             |
| `similarity_functions.py` (`cos_sim`, `dot_score`)                         | `similarity-functions.ts`                               |
| `_create_dataloaders.py` (text)                                            | `create-dataloaders.ts`                                 |
| `abstasks/task_metadata.py`                                                | `abstasks/task-metadata.ts`                             |
| `abstasks/abstask.py`                                                      | `abstasks/abstask.ts`                                   |
| `abstasks/retrieval.py`                                                    | `abstasks/retrieval.ts`                                 |
| `abstasks/retrieval_dataset_loaders.py`                                    | `abstasks/retrieval-dataset-loaders.ts`                 |
| `tasks/retrieval/eng/argu_ana_retrieval.py`                                | `tasks/retrieval/eng/argu-ana-retrieval.ts`             |
| `tasks/retrieval/eng/scidocs_retrieval.py`                                 | `tasks/retrieval/eng/scidocs-retrieval.ts`              |
| `_evaluators/evaluator.py`                                                 | `evaluators/evaluator.ts`                               |
| `_evaluators/retrieval_evaluator.py`                                       | `evaluators/retrieval-evaluator.ts`                     |
| `_evaluators/retrieval_metrics.py`                                         | `evaluators/retrieval-metrics.ts`                       |
| `models/models_protocols.py`                                               | `models/models-protocols.ts`                            |
| `models/abs_encoder.py`                                                    | `models/abs-encoder.ts`                                 |
| `models/search_wrappers.py` (`SearchEncoderWrapper`)                       | `models/search-wrappers.ts`                             |
| `models/openai_wrappers.py` (`OpenAIAPIEncodeWrapper`)                     | `models/ai-sdk-encoder.ts`                              |
| `models/instruct_wrapper.py` (`InstructSentenceTransformerModel`)          | `models/instruct-wrapper.ts`                            |
| `models/model_implementations/qwen3_models.py`                             | `models/model-implementations/qwen3-models.ts`          |
| `models/model_implementations/google_embeddinggemma.py` (EmbeddingGemma 2) | `models/model-implementations/google-embeddinggemma.ts` |
| `models/model_meta.py`                                                     | `models/model-meta.ts`                                  |
| `results/task_result.py`                                                   | `results/task-result.ts`                                |
| Python's `json` module (`NaN` tokens, float repr)                          | `results/json.ts`                                       |
| `results/model_result.py`                                                  | `results/model-result.ts`                               |
| `results/benchmark_results.py`                                             | `results/benchmark-results.ts`                          |
| `cache/result_cache.py` (local folder)                                     | `cache/result-cache.ts`                                 |
| `evaluate.py`                                                              | `evaluate.ts`                                           |
| pytrec_eval 0.5.11 (`RelevanceEvaluator`, trec_eval)                       | `dependencies/pytrec-eval.ts`                           |
| NumPy 2.5.4 (pairwise sum, mean, std, argsort, linspace)                   | `dependencies/numpy.ts`                                 |
| scikit-learn 1.9.1 (`sklearn.metrics.auc`)                                 | `dependencies/sklearn.ts`                               |
| packaging 26.3 (`packaging.version.Version`)                               | `dependencies/packaging.ts`                             |
| CPython 3.12 (`sum`, `round`, `repr`, string order)                        | `dependencies/python.ts`                                |
| CPython 3.12 `heapq`                                                       | `dependencies/heapq.ts`                                 |

## Conventions

- The public API of a ported class is the public API of its MTEB class, also where this package does not call a method yet (`TaskResult.merge`, `ResultCache.getModels`, `ModelMeta.openness`, the `remote/` folder of a cache that MTEB filled). A Python method that starts with `_` and has no caller here is not ported.
- Classes keep their Python names (`AbsTaskRetrieval`, `TaskMetadata`). Functions, methods and fields take the camelCase form of the Python name: `calculate_retrieval_scores` is `calculateRetrievalScores`, `hf_split` is `hfSplit`. A Python method that starts with `_` is a `#` member, or a function that the module does not export.
- Keyword-only parameters become one options object. Positional parameters stay positional.
- Encoding, search, loading and `evaluate` are async, because an encoder calls a model over the network. MTEB's are synchronous.
- A HuggingFace `Dataset` is an array of rows. A Python `dict` that maps ids is a `Map`: a `Map` keeps insertion order for every key, and an object moves integer-like keys such as `"0"` to the front.
- An MTEB `Array` (a numpy array or a torch tensor) is `Embeddings`, one `Float32Array` for each row. Embeddings and similarity scores are float32, as in MTEB; the other numbers are float64, as in Python.
- A pydantic model is a zod schema and a class. Files on disk keep the keys, the structure and the `NaN` values of MTEB, so MTEB and this package read the files of each other.
- Numbers follow the Python algorithms where the result can differ: `sum` of floats is Neumaier summation (CPython 3.12), `round` rounds half to even, a numpy sum is a pairwise sum, and ties sort as Python tuples sort.

## Differences

- Not ported: logging, tqdm progress bars, the CO₂ tracker (codecarbon), device selection and `torch.compile`, `num_proc`, the remote result repository of the HuggingFace Hub and `submit_results`, the leaderboard, the lookup of tasks and models by name (`get_task`, `get_model`; the ported tasks are classes and the ported models are `ModelMeta` values), descriptive statistics, search index backends (`index_backend`), and the `encode` and `similarity` methods of `SearchEncoderWrapper`, which only pass the call to the wrapped model and have no caller here. A retrieval task loads its dataset from the HuggingFace Hub or from a folder on disk (see Datasets below); any task can override `loadData`.
- The similarity scores are float32, but the summation order of a BLAS matrix product depends on the library and the processor. Thus a score can differ from MTEB in its last float32 bit, and so can the nAUC values that use the scores. The trec_eval measures, the MRR and the rounded scores are the same when the scores are the same.
- MTEB's encoders over text models share `AiSdkTextEncoder` (`models/ai-sdk-text-encoder.ts`), which has no Python module of its own: it sends the texts to an AI SDK embedding model in batches, gives float32 embeddings and adds up the tokens. `AiSdkEncoder`, `InstructAiSdkEncoder` and `EmbeddingGemma2Encoder` give the text of each input, as `OpenAIAPIEncodeWrapper`, `InstructSentenceTransformerModel` and `EmbeddingGemma2Wrapper` do.
- Datasets: `RetrievalDatasetLoader` reads the configs of the dataset card (`README.md`) of the repository at its revision, and downloads the data files of a split from `<endpoint>/datasets/<repository>/resolve/<revision>/<path>`. It reads JSON Lines files only, and does not infer data files for a card without configs. It keeps the files in `~/.cache/mteb/datasets/<repository>/<revision>/`, not in the cache of the datasets library. The qrels of a query keep the order of the file; MTEB's `group_by(maintain_order=False)` has no fixed order. When the repository is a folder on disk, the loader reads the files of that folder, as `load_dataset` reads a local path (`datasets/load.py`: `os.path.isdir(path)`). It does not use the revision or the cache for a folder.
- Model loading: `ModelMeta.loadModel(model, kwargs)` takes the AI SDK embedding model of a server that serves the weights (llama.cpp, Ollama, vLLM), where MTEB loads the weights. The model is not an experiment argument; the other keyword arguments with a value are. The loader gets the metadata of the encoder in its options, where MTEB sets it on the model after the loader returns. `embed_dim` (Matryoshka truncation) and `device` are not ported.
- EmbeddingGemma 2: the text tower only (no MIEB or MAEB inputs), so the metadata reports text with the parameters and memory of that tower, as MTEB does for a text-only load. `embeddinggemma-300m` is not ported yet. The instruction table keeps the instructions; the comments of MTEB about instructions that were submitted differently are not copied.
- `OpenAIAPIEncodeWrapper` sends HTTP requests to an OpenAI-compatible server. `AiSdkEncoder` calls `embedMany` of an AI SDK embedding model in its place, so it supports every provider of the AI SDK, and it adds up the tokens that the provider reports.
- A task gives its metadata to the constructor of `AbsTask`. Python declares it on the class, but the field initializers of a TypeScript subclass run after the constructor of the base class. `dataLoaded` is true while `dataset` is set; `unloadData` sets `dataset` to null. A dataset always has a subset level, also when the only subset is `"default"`.
- `get_abstask_prompt` finds the class of a task among the imported task classes. This package cannot list classes, so each task records its prompt in its constructor.
- `retrieval_metrics.py`: the extra scores that single tasks of MTEB's catalogue compute (p-MRR of FollowIR, paired accuracy, robustness@10, the maximum over sub-queries, capped recall, holes, top-k accuracy) are not ported. They come with a task that needs them, through `taskSpecificScores`. `retrievalTexts` of `_create_dataloaders.py` and `_process_relevant_docs` of `abstasks/retrieval.py` serve the descriptive statistics and are not ported either.
- `filter_languages` and `validate_task_to_prompt_name` are not ported: the first needs MTEB's language table, the second its task registry.
- An evaluator does not seed global random generators: JavaScript has no seeded global generator.
- `torch.topk` does not fix the order of equal scores; here the lower index comes first. The order changes only the position of a document in the result map, because the metrics sort the scores again.
- `instruction_template.format(instruction=...)` replaces `{instruction}` only; Python's `str.format` also reads `{{` and other fields.
- Task metadata: a language code is checked by its shape (three lowercase letters), not against MTEB's table of 7,922 codes; the 223 script codes are checked exactly. A date is `YYYY-MM-DD` or a datetime at midnight; pydantic also takes Unix timestamps. A validation error names the camelCase field.
- Model metadata: `ScoringFunction` is a const object, and `'euclidean'`, `'manhattan'` and `'custom'` are plain strings. A whole float in the experiment arguments gives its integer form in the experiment name (`1.0` is `"1"`). `fromDict` always sets the loader to null, because there is no model registry. `hashKey()` and `equals()` stand for `__hash__` and `__eq__`. The training datasets keep their insertion order; in Python a set has no fixed order. Not ported: `load_model`, the Hub constructors and calculations, zero-shot checks, model cards.
- Results: results older than MTEB 1.11.0 do not load, and the pair-classification fix for results older than 1.12.48 is not ported. A result knows its task only through `fromTaskResults` or `validateAndFilterScores(task)`. `joinRevisions` has no registry, so it ranks revisions by MTEB version, then by whether the revision is known. A revision folder without `model_meta.json` has no model metadata. pandas and polars frames, `to_dataframe` and the leaderboard cache are not ported.
- Result files: a whole float is written as an integer (`1`, not `1.0`), and a date has milliseconds, not microseconds. `run_settings.jsonl` records the version of MTEB only. MTEB loads `model_meta.json` without validation; this package validates it. Cache listings are sorted; Python keeps the order of the file system.
- MTEB treats a result folder as an experiment when any part of its absolute path is `experiments` (`"experiments" in path.parts`). So a cache below a folder such as `~/Desktop/experiments` reads its results as experiments. This package looks for `experiments` only in the folder layout below `results/`.
- pytrec_eval keeps the relevance of the last query in a static cache (`form_res_rels.c`). When one call ends with the query id that the next call starts with, the next call reads the old relevance. This package computes each call again. For a query whose judgments are all negative, trec_eval keeps the number of relevance levels of the query before it; here such a query has no levels.

## Behavior kept from MTEB on purpose

- `OpenAIAPIEncodeWrapper` finds the prompt name in `model_prompts`, which it never sets, so `prompt_dict` alone gives no prompt. `AiSdkEncoder` does the same, so both give the same embeddings for the same options.

## Copies inside this package

Two pydantic rules have two copies each: the alias of a field (`eval_langs` to `evalLangs`) is the function `camelCase` in `abstasks/task-metadata.ts` and `models/model-meta.ts`, and a pydantic `float` (a number that can be NaN or infinite) is the schema `float` in `models/model-meta.ts` and `results/task-result.ts`. The copies are the same. By the Rule of Three, a third place that needs it moves it to `dependencies/`, with both copies (backlog #3241). Until then, change both.

## Golden tests

`src/evaluators/fixtures/retrieval-metrics.json` holds random qrels and runs and their scores from MTEB 2.26.28, pytrec_eval-terrier 0.5.11, NumPy 2.5.4 and CPython 3.12.9: graded, negative and unjudged relevance, equal scores, scores that are equal only as float32, and cutoffs out of order. `retrieval-metrics.golden.test.ts` requires the same numbers to the last bit. A change to the summation, the rounding, the float32 conversion or the order of equal scores fails it.

`src/abstasks/fixtures/retrieval-task.json` holds a small retrieval task and its scores from MTEB, as a full corpus search and as a reranking. Its vectors make every similarity exact in float32, so `retrieval.test.ts` compares the whole path, from the encoder to the scores, to the last bit. `src/results/fixtures/python-mteb-2.26.28/` holds result files that MTEB wrote, which this package reads and writes back.

On 2026-10-28, a retrieval task on the event-detection sets gvc and anthropic-outlets ran with EmbeddingGemma 2 on llama.cpp, once with MTEB and once with this package. All 112 scores of each set, the nAUC values among them, were equal.

On 2026-10-28, `examples/compare-models.ts` ran the ported models on MTEB's tasks, with the Q8_0 weights on llama.cpp b11836. The main scores (nDCG@10) and MTEB's published scores:

| Model                | Task    | This package | MTEB   |
| -------------------- | ------- | ------------ | ------ |
| EmbeddingGemma 2     | ArguAna | 0.5974       | 0.5983 |
| EmbeddingGemma 2     | SCIDOCS | 0.1808       | 0.1819 |
| Qwen3-Embedding-0.6B | ArguAna | 0.6942       | 0.7097 |
| Qwen3-Embedding-0.6B | SCIDOCS | 0.2436       | 0.2441 |

MTEB 2.26.10 made the scores of EmbeddingGemma 2 with the recipe of its registry. The scores of Qwen3-Embedding say MTEB 1.38.9, which has no Qwen3-Embedding in its registry, so the authors of the model made them with their own code.
