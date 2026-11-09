# Copied code

This package keeps one copy inside the package: the reader of a file of the HuggingFace Hub. The parts that it copied from the information-filtering evals moved to `@zukhruf/statistics` and `@zukhruf/random`.

## From the information-filtering evals

The paired bootstrap test of this package (`src/significance/paired-bootstrap.ts`) compares the scores of a change and its baseline query by query. The evals of `@zukhruf/relevance-filtering` and `@zukhruf/event-detection` (`packages/information-filtering/`) already compare two designs with a bootstrap and a verdict. This package kept its own copy of four parts of them. Three parts reached their third place and moved to `@zukhruf/statistics` (backlog #3819): the resample loop (`IidBootstrap`), NumPy's `linear` quantile (`Linear`, through `PercentileInterval`), and the side of a value on which an interval lies (`ConfidenceInterval.isAbove` and `isBelow`, from which each verdict builds its own rule). The fourth part, the port of `numpy.random.default_rng`, moved to `@zukhruf/random` at its second place (backlog #3411, [random ADR 0001](../../random/docs/adr/0001-one-package-for-the-generators-of-numpy-random.md)). The legacy `RandomState` of this package moved with it. Three parts are now a copy at their second place: `PairedBootstrap` of `@zukhruf/evals` also pairs two sets by key and refuses a key that only one set has, gives its verdict from the side of 0 on which the interval lies, and computes the p-value as this package does (backlog #4009, `packages/evals/docs/copied-code.md`). A fix in one copy is made in the other copy too, and the commit names both files.

### Not copied

The article bootstrap of the relevance-filtering eval (`articleWeights`, `articleBootstrap`), the block bootstrap and the Mulberry32 generator of the event-detection eval, and the roles, answer keys and runners of both evals. They are about frozen designs and their labelled sets, and this package has neither.

## The Hub file reader, inside this package

Two places read a file of a HuggingFace Hub repository at a revision through a cache folder, and write the file in one step. `dependencies/datasets.ts` reads the files of a dataset for `loadDataset`. `dependencies/tokenizers.ts` reads `tokenizer.json` of a model for `Tokenizer.fromPretrained`. This is the second place, so the reader is copied, not shared (Rule of Three). A third place that reads a Hub file starts the extraction (backlog #3484). The three working copies then give the boundary of the shared reader. Until then, make each fix in both copies, and name both files in the commit.

**`dependencies/datasets.ts` `HubRepository.read` and `keep` → `dependencies/tokenizers.ts` `hubFile` and `keep`.**
Both read a file from `.../<repository>/resolve/<revision>/<path>` of the endpoint, keep it in `<cache folder>/<repository>/<revision or commit>/<path>`, read the file from the cache when it is there, and write it through a `.partial` file and a rename. `keep` is the same.
Changes: `hubFile` reads a model repository, so its URL has no `datasets/` part, and its default cache folder is `~/.cache/mteb/models`. MTEB reads the tokenizer at `main`, a branch, so `hubFile` does what `hf_hub_download` does for a branch: a HEAD request gives the commit (`X-Repo-Commit`) and the content id (the `ETag`), the file stays under the commit, and `refs/main` keeps the commit. When the Hub cannot be reached, `refs/main` gives the commit and the file. `hubFile` downloads from the `Location` of the HEAD response, and it checks the bytes against the content id. `HubRepository` reads a dataset at a fixed commit, so it needs none of these.

@huggingface/hub 2.17.10 cannot replace either copy. For a branch, `downloadFileToCacheDir` keeps the file under the last commit that changed the file, not under the commit of the branch (`src/lib/download-file-to-cache-dir.ts`: `const snapshotId = commitHash ?? info.lastCommit?.id ?? etag;`). It asks the Hub before it reads the cache, so it cannot load a branch without the network, and it does not check the bytes.

## Test helpers in two places

The golden tests of the abstract tasks keep these copies. A fix in one copy goes into the other copy, and the commit names both files.

**`codePointEncoder` that gives shares.**

- Places: `src/abstasks/classification.golden.test.ts` and `src/abstasks/multilabel-classification.golden.test.ts`.
- Same: the value at k is the float32 share of the code points of the text.
- Not counted: `embedCodePointCounts` in `src/testing/encoders.ts` gives counts, so it has other knowledge.

**The test of the undersampling.**

- Places: `src/abstasks/classification.golden.test.ts` and `src/abstasks/multilabel-classification.golden.test.ts`.
- Same: the test compares the experiments of a task with `expected.json`.
- Not counted: the test in `src/abstasks/regression.golden.test.ts` reads each subset of a task.

## Same name, other knowledge

`recordingEncoder` in `src/models/cache-wrappers/cache-wrapper.golden.test.ts` keeps its own body. It builds the encoder of a different `generate.py`, and it records the texts that reached the model, not the calls of the encoder.
