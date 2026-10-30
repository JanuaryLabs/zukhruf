# The package is a port of MTEB

A retrieval evaluation of embedding models on the labelled sets of `@zukhruf/event-detection` ran MTEB, a Python framework. MTEB's command line cannot load a task that is not in its registry, so the evaluation needed a Python launcher, a virtual environment of 1.4 GB (MTEB requires torch) and a second toolchain beside Node. Of MTEB, the evaluation used the engine only: the task, the search, the metrics, the results and the cache. It did not use MTEB's datasets, its model registry or its leaderboard.

Thus this package ports the engine of MTEB 2.26.28 to TypeScript, module by module (`docs/ported-from-mteb.md`). It does not write a new benchmark framework. The names, the score keys and the files on disk stay those of MTEB, so a result of one can be compared with a result of the other.

The scores must be the same as MTEB's. MTEB's numbers come from pytrec_eval, NumPy and CPython: trec_eval stores a score as a float32, NumPy adds in pairs, CPython 3.12 adds with compensation and rounds half to even. `src/dependencies/` ports each of these algorithms, and golden tests require the numbers of MTEB to the last bit.

The encoder is an AI SDK embedding model, as in `@zukhruf/embeddings`. It takes the place of MTEB's `OpenAIAPIEncodeWrapper`, so each provider of the AI SDK works, with its API key, and the encoder adds up the tokens that the provider reports.

## Considered Options

- **MTEB from a Python launcher.** It works, but needs Python, torch and uv beside Node, and CI has none of them.
- **A new framework.** It would make a benchmark that nobody else uses, with scores that cannot be compared with MTEB.
- **A port of MTEB's engine.** This option was selected.

## Consequences

- A change of MTEB is a change here: compare the source modules at the new tag, as the ledger describes.
- The first step has the retrieval and reranking tasks, for text. The other task types need ports of scikit-learn and SciPy algorithms (logistic regression, k-means, correlations); their numbers can differ from MTEB in the last digits.
- The similarity scores of real models can differ from MTEB in their last float32 bit, because the order of a BLAS sum depends on the library. On two of the labelled sets of `@zukhruf/event-detection`, all scores were equal.
