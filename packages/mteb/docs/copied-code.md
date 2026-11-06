# Copied code

This package keeps copies of code from the information-filtering evals, and one copy inside the package: the reader of a file of the HuggingFace Hub.

## From the information-filtering evals

The paired bootstrap test of this package (`src/significance/paired-bootstrap.ts`) compares the scores of a change and its baseline query by query. The evals of `@zukhruf/relevance-filtering` and `@zukhruf/event-detection` (`packages/information-filtering/`) already compare two designs with a bootstrap and a verdict. This package kept its own copy of four parts of them. Three parts reached their third place and moved to `@zukhruf/statistics` (backlog #3819): the resample loop (`IidBootstrap`), NumPy's `linear` quantile (`Linear`, through `PercentileInterval`), and the side of a value on which an interval lies (`ConfidenceInterval.isAbove` and `isBelow`, from which each verdict builds its own rule). One part stays a copy: the port of `numpy.random.default_rng`.

The reason is the Rule of Three (workspace ADR 0001, rule 2). This package is the second place of the generator port. A third port of `numpy.random.default_rng` starts its extraction (backlog #3411). Until then, make each fix in both copies, and name the files in the commit.

Paths on the left are in `packages/information-filtering/`. Paths on the right are in `packages/mteb/src/`.

### Copied without changes

- `relevance-filtering/eval/numpy-random.test.ts` → `dependencies/numpy-random.test.ts`: the integers of `numpy.random.default_rng` for two seeds.

### Copied with changes

**`relevance-filtering/eval/numpy-random.ts` → `dependencies/numpy-random.ts`.**
Both give `numpy.random.default_rng(seed).integers(low, high, size)` bit for bit: SeedSequence, PCG64 and Lemire's bounded integers.
Changes: the first comment names the paired bootstrap test of this package and the tasks that draw from the generator, not the research code and the exam rule of the eval. The code of `integers` is the same. This copy also has `shuffle` and `permutation` (`random_interval`), `choiceWithoutReplacement` (Floyd's algorithm, which draws with the same Lemire's bounded integers as `integers`), and the legacy `RandomState`, which the eval does not have.

### Not copied

The article bootstrap of the relevance-filtering eval (`articleWeights`, `articleBootstrap`), the block bootstrap and the Mulberry32 generator of the event-detection eval, and the roles, answer keys and runners of both evals. They are about frozen designs and their labelled sets, and this package has neither.

### Backlog

#3411 waits for a third port of the generator. Its interim rule: mirror every fix in both copies, and name the files in the commit.

## The Hub file reader, inside this package

Two places read a file of a HuggingFace Hub repository at a revision through a cache folder, and write the file in one step. `dependencies/datasets.ts` reads the files of a dataset for `loadDataset`. `dependencies/tokenizers.ts` reads `tokenizer.json` of a model for `Tokenizer.fromPretrained`. This is the second place, so the reader is copied, not shared (Rule of Three). A third place that reads a Hub file starts the extraction (backlog #3484). The three working copies then give the boundary of the shared reader. Until then, make each fix in both copies, and name both files in the commit.

**`dependencies/datasets.ts` `HubRepository.read` and `keep` → `dependencies/tokenizers.ts` `hubFile` and `keep`.**
Both read a file from `.../<repository>/resolve/<revision>/<path>` of the endpoint, keep it in `<cache folder>/<repository>/<revision or commit>/<path>`, read the file from the cache when it is there, and write it through a `.partial` file and a rename. `keep` is the same.
Changes: `hubFile` reads a model repository, so its URL has no `datasets/` part, and its default cache folder is `~/.cache/mteb/models`. MTEB reads the tokenizer at `main`, a branch, so `hubFile` does what `hf_hub_download` does for a branch: a HEAD request gives the commit (`X-Repo-Commit`) and the content id (the `ETag`), the file stays under the commit, and `refs/main` keeps the commit. When the Hub cannot be reached, `refs/main` gives the commit and the file. `hubFile` downloads from the `Location` of the HEAD response, and it checks the bytes against the content id. `HubRepository` reads a dataset at a fixed commit, so it needs none of these.

@huggingface/hub 2.17.10 cannot replace either copy. For a branch, `downloadFileToCacheDir` keeps the file under the last commit that changed the file, not under the commit of the branch (`src/lib/download-file-to-cache-dir.ts`: `const snapshotId = commitHash ?? info.lastCommit?.id ?? etag;`). It asks the Hub before it reads the cache, so it cannot load a branch without the network, and it does not check the bytes.
