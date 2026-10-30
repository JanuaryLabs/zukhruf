# Evaluation of the event detector

The parameters of the detector come from research rounds #3130 and #3152 ([ADR 0001](../docs/adr/0001-the-parameters-are-frozen-by-research-round-3130.md), [ADR 0005](../docs/adr/0005-research-round-3152-adds-a-same-publisher-term-and-fits-the-weights-again.md)). This folder lets you measure the detector again, on the same labelled sets, before and after a change. It is not in the npm package and not in the build.

Run the evaluation before you change a parameter, the lead rule, the similarity source or the model. Then run it again after the change.

The eval of `@zukhruf/relevance-filtering` copies `roles.ts`, `answer-key.ts`, `bootstrap.ts`, `verdict.ts` and `run.ts` of this folder ([its ledger](../../relevance-filtering/docs/copied-code.md), backlog #3261). Make each fix in both copies, and name both files in the commit.

## Run it

The evaluation needs the embedding model of round #3130: EmbeddingGemma 2 Q8_0 on llama.cpp b11836. CI does not have the model, so the `eval` target runs only on a machine with the model. CI does not run it.

1. Start the embedding server with the arguments of round #3130:

   ```sh
   llama-server -m embeddinggemma-2-Q8_0.gguf --alias embeddinggemma-2 \
     --host 127.0.0.1 --port 8096 -c 8192 -np 1 -t 2 -tb 2 -b 8192 -ub 2048 --embedding
   ```

2. Run the evaluation:

   ```sh
   EVAL_EMBEDDING_URL_EMBEDDINGGEMMA_2=http://127.0.0.1:8096/v1 npx nx run event-detection:eval
   ```

3. Stop the server.

Give set names to score only those sets, for example `npx nx run event-detection:eval -- gvc hlgd-test`. `--help` shows the options.

Each embedding model has its own server. The runner and the fit read the base URL of the server of a model from the variable `EVAL_EMBEDDING_URL_` and the name of the model (`embeddingModel` of the design) in capitals, with `_` for each other character. For example, the variable of `embeddinggemma-2` is `EVAL_EMBEDDING_URL_EMBEDDINGGEMMA_2`, and the variable of `qwen3-embedding-0.6b` is `EVAL_EMBEDDING_URL_QWEN3_EMBEDDING_0_6B`. Set the variable of each model that the run uses.

Each model has a probe: `probes/<model>.json`. It holds a text, the vector of the text, the sha256 of the GGUF file, the llama.cpp build and the server arguments. Before the runner or the fit uses a server, it embeds the probe text. If the vector is not the vector of the probe, it stops. Thus a server with another model or another quantization cannot give scores. Two designs of one model, such as 3130 and 3152b, share the probe of the model.

## What a run does

For each set, the runner does these steps:

1. It reads the answer key and checks its hash against `set.json`.
2. It gets the text of each report (see [Texts](#texts)).
3. It gives the reports to a new `EventDetector` in an in-memory database, with the design that the run scores (`DESIGN` in `run.ts`), as a host does: one `add` for each publish day, in the order of the publish dates. Reports with equal dates keep the order of the answer key. Each report has the publisher of its answer-key row, when the row has one.
4. After the last day, it adds one headline-only report of the next day. This makes the detector cluster the last window again, so the events of the last day are final. The headline-only report never joins an event (ADR 0003).
5. It scores the events against the answer key and writes `results/<set>.json`.

The vectors are in `cache/vectors/<model>/<recipe>/<set>.sqlite`, through the `Collection` of `@zukhruf/embeddings`. A collection keeps one vector for each report, so each model has its own folder, and each way to make the vector text has its own folder in it. `<recipe>` is the first 12 characters of the sha256 of the lead rule and the vector text of the design. The collection embeds a lead again only when its text or the model name changed. Thus a second run embeds nothing.

Each result has the scores of the coreference literature. The answer key and the detector each put the reports of the set into events, and each metric compares the two partitions:

| Metric  | Definition                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| MUC     | Vilain et al. 1995. It counts the links that join the reports of one event. It does not see an event of one report.                    |
| B-cubed | Bagga and Baldwin 1998. It averages a precision and a recall over the reports.                                                         |
| CEAF-e  | Luo 2005, with the similarity φ4. It aligns each gold event with at most one detector event (Kuhn-Munkres).                            |
| BLANC   | Recasens and Hovy 2011, in the form of Luo et al. 2014. It averages the scores of the coreference links and the non-coreference links. |
| Pair    | The precision and the recall of the pairs of reports that the detector joins. It is the coreference part of BLANC.                     |
| CoNLL   | Pradhan et al. 2014. It is the mean of the MUC, B-cubed and CEAF-e F.                                                                  |

Each metric has a precision P, a recall R, F1 and F0.5. Use F1 to compare with the literature. F0.5 counts precision two times as much as recall, because a false join hides a report from the reader, and a false split only shows a duplicate (ADR 0003). CoNLL has F1 and F0.5 only.

The metrics use the conventions of the reference scorer, github.com/conll/reference-coreference-scorers v8.01 (Pradhan et al. 2014):

- The events of one report count. B-cubed, CEAF-e and BLANC see them. MUC does not see them, by its definition.
- A ratio with a denominator of 0 is 0.
- When the answer key has no event of two or more reports, BLANC is the score of the non-coreference links alone. When the answer key has one event only, BLANC is the score of the coreference links alone.

`metrics/reference-scorer.test.ts` holds the 36 test cases of the reference scorer with their published values, and the metrics give each value. On each of the six sets that are not the exam, the reference scorer and the metrics give the same scores for the partition of design 3152 (2026-10-27).

### The main score

The main score is the CoNLL F0.5: the mean of the MUC, B-cubed and CEAF-e F0.5. This is the objective of each research round from 2026-10-27, written before the next round. BLANC, the pair scores and F1 are secondary.

B-cubed F0.5 alone cannot be the objective. On a set where most events have one report, B-cubed gives a high score to a design that joins nothing. On anthropic-outlets, that design has a B-cubed F0.5 of 0.940, and design 3130 has 0.812. MUC gives that design 0, so the CoNLL F0.5 of that design is 0.560, and the CoNLL F0.5 of design 3130 is 0.701.

### Baselines

The runner also scores two partitions that need no detector:

- **All singletons**: each report is an event of its own.
- **All in one**: all reports are one event.

A design must have a higher main score than both baselines on a set. If it does not, it is not a gain on that set, and `--accept` refuses it.

### The change against the latest accepted design

The runner compares the events of the run with the events of the latest accepted design (`accepted/<design>.json`). It gives the change of the main score and its 95% interval. The interval comes from a paired bootstrap (Efron and Tibshirani 1993; Koehn 2004): 2,000 replicates with the fixed seed 3182. Each replicate draws units with replacement and scores both designs on the same draw.

When `accepted/<design>.json` has no events of the accepted design on the labels of the set, the runner runs the accepted design in the same run. It takes the design from the pin of its scoreboard entry, and it runs it through the detector of the package. This is the case for an exam set, a new set and a set with fixed labels. On a set that no accepted design scored, the runner compares with the latest accepted design. `results/<set>.json` then holds the events and the CoNLL F0.5 of the accepted design (`accepted`).

A unit is a block of whole gold events. A block holds the gold events that one of the two designs joins with each other. Thus a false join stays in its unit, and the units are independent. When neither design joins two gold events, each unit is one gold event. A design that joins many gold events makes few blocks. The runner shows the number of blocks; with few blocks, the interval is narrow and tells you little.

### Other scores in a result

- The pair scores of pairs of two publishers and of pairs of one publisher, when the set has publishers.
- The scores without the ambiguous reports, when the set has ambiguous reports.
- The time of each `add`. It includes the embedding only of the leads that are not in the vector cache, so a second run measures the grouping alone.
- Each false join and each false split, with the titles of the reports.
- The event of each report (`eventOf`).

## Sets

Each folder in `sets/` is one set. It has two files:

- `answer-key.json`: one row for each report: `id`, `source`, `publishedAt`, `publisher` (when known), `event`, `ambiguous` (when the annotator was not sure) and `textSha256`. It has no publisher text.
- `set.json`: the role, the freeze date, the first-scored date, the hash of the labels, the annotator, the boundary rule, the source with its licence and attribution, and the known weaknesses of the labels.

| Set               | Reports | Events | Role       | Text                                             |
| ----------------- | ------- | ------ | ---------- | ------------------------------------------------ |
| anthropic-outlets | 816     | 618    | training   | Web pages of 6 publishers, April to October 2026 |
| deepmind-outlets  | 133     | 102    | regression | Web pages of 5 publishers, April to October 2026 |
| nvidia-outlets    | 687     | 524    | regression | Web pages of 6 publishers, April to October 2026 |
| ecbplus           | 982     | 86     | training   | ECB+ corpus, rebuilt from its tokens             |
| dev2938           | 217     | 209    | training   | Web pages of 12 publishers, October 2026         |
| fresh2957         | 48      | 23     | training   | WCEP-10 rows on Hugging Face                     |
| gvc               | 509     | 241    | regression | Gun Violence Corpus, rebuilt from its tokens     |
| hlgd-test         | 286     | 125    | regression | HLGD headlines                                   |
| labs-outlets      | 745     | 677    | training   | Reports of the reader app, 41 labs and outlets   |

### Roles

- **Training**: you can tune a design on this set.
- **Regression**: a new design must not be worse on this set than the latest accepted design. It is worse only when the whole 95% interval of the change of its main score is below 0. Do not tune on it.
- **Exam**: no design has seen this set. The runner scores it one time only, with `--exam`, as the test of a frozen design. It then writes the first-scored date into `set.json`, and the set is a regression set from then on. A run with `--exam` scores a set that has a first-scored date as a regression set.

The one score of an exam set also gives the verdict of the design against the accepted design. The runner applies the exam rule of round 3152b (`rounds/3152b/selection-rule.json`, `examVerdict`):

- (a) The 95% interval of the change of the main score on the exam set is entirely above 0.
- (b) The main score on the exam set is higher than both baselines.
- (c) No regression set of the run has an interval that is entirely below 0.

The result is "pass" when (a), (b) and (c) hold. It is "fail" when (b) or (c) does not hold, or when the interval of (a) is entirely below 0. Otherwise it is "inconclusive", and the accepted design stays. The runner writes the verdict into `results/<set>.json`. `--exam` needs every regression set in the same run, so it refuses set names.

To add a new labelled set, freeze its labels first. Give it the role `exam` and no first-scored date. Score it with `--exam` only when the design is frozen.

### Labels

The labels are as their annotators wrote them. `set.json` lists the known weaknesses of each set. For example, an AI model labelled anthropic-outlets, dev2938 and fresh2957 alone, and it read only the title and the lead of each anthropic-outlets report.

When you find a wrong label, fix it in `answer-key.json` in its own commit, and give the reason in the commit message. Write the new hash into `labelsSha256` of `set.json`; the runner tells you the hash. A regression check compares only scores on the same labels.

## Texts

The repository holds no publisher text. The runner gets the texts when it runs and keeps them in `cache/texts/<set>.json`, with the sha256 of each text. Each row of the answer key has the sha256 of the text that its labels and the accepted scores were made with.

| Text source | Where the runner gets it                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| gvc         | `verbose.conll` of github.com/cltl/GunViolenceCorpus at commit 1d80c3a, checked by its sha256                     |
| ecbplus     | `ECB+.zip` of github.com/cltl/ecbPlus at commit 3aa071e, checked by its sha256. It needs `unzip`.                 |
| hlgd        | `hlgd_original_annotations.json` of release 0.1 of github.com/tingofurro/headline_grouping, checked by its sha256 |
| wcep        | The rows API of datasets-server.huggingface.co for allenai/wcep_dense_max                                         |
| web         | The URL of each report                                                                                            |

The web fetch reads robots.txt, sends one request each second, and names itself in its user agent. It stops asking a host that answers 429 or 403. It extracts the text with Readability.

The texts of anthropic-outlets and dev2938 in the cache came from the research crawls, which used elt's article extraction. On a machine without that cache, the runner fetches the pages again, and Readability gives other texts. The runner then reports each such text as changed.

The runner never drops a report without a message:

- A report with no text has vanished. The runner scores the set without it and gives the reason.
- A report whose text hash is not the hash of the answer key has changed. The runner scores it and says so.

`--refresh` gets each text from its source again. Use it to see if the sources changed.

## Fit a design

A research round chooses a design on the training sets. `nx run event-detection:fit -- <round>` does that work in the repository. It reads `rounds/<round>/selection-rule.json` and writes `rounds/<round>/plan.json`. It needs the embedding server of [Run it](#run-it):

```sh
EVAL_EMBEDDING_URL_EMBEDDINGGEMMA_2=http://127.0.0.1:8096/v1 npx nx run event-detection:fit -- 3152b
```

The fit does these steps:

1. It reads `set.json` of each set of the rule first. It refuses a training set whose role is not `training`, and a regression set whose role is not `regression`. An exam set that was scored once is a regression set. Thus it never opens the answer key of an exam set that was never scored.
2. It cuts the training sets into the folds of the rule.
3. For each fold, it gets the training pairs: the shortlist pairs of each report, from the `neighbourGraph` of the vectors of the fold. The pair features come from `pairFeatures` (`src/pair-score.ts`), the function of the pair score.
4. It fits the weights of the pair score by logistic regression (`fit/irls.ts`), and it chooses the threshold by nested cross-validation of the CoNLL F0.5 (`fit/cross-validation.ts`). Each fold score comes from the `EventDetector` of the package, fed as the runner feeds it.
5. It does steps 3 and 4 for each candidate of the rule. Each candidate gets its own weights and threshold.
6. It checks the eligibility rules of each candidate. E3 compares with the reference design of the rule, which it runs from its scoreboard pin. E2 compares with the reference design as it is, or with the cross-validated score of a candidate that the rule names.
7. It applies the choice of the rule. With one candidate, the candidate is chosen when it is eligible. With an incumbent and challengers, the eligible challenger with the best objective is chosen only when the paired bootstrap 95% interval of (challenger - incumbent) on the cross-validated objective is entirely above 0 (`fit/selection.ts`, `crossValidatedChange`).

`plan.json` holds, for each candidate, the fitted design, the cross-validation of each family and the eligibility checks. It also holds the choice and the sha256 of the rule and of the labels. The fit uses the detector of the package, not a copy, so the design that it chooses is the design that the package runs (Google, Rules of Machine Learning, rule 32). A fit runs the detector about 1,600 times for each candidate, and takes about 20 minutes for each candidate.

`rounds/3232` holds round #3232, Qwen3-Embedding-0.6B against design 3152b: its rule, its plan and the cost of each model (`cost.json`). `rounds/3142` holds round #3142, a clean body and the template segments of each publisher against a refit of design 3152b, with the training set labs-outlets. Its design T was chosen, and its exam on nvidia-outlets was inconclusive, so design 3152b stays. `rounds/3152b` holds the rule of round 3152b for its chosen candidate only. From the training sets alone, the fit gives the weights of `design3152b` to 1e-6, its threshold 0.45 and its cross-validated CoNLL F0.5 (#3184).

## Scoreboard

`scoreboard.json` holds the scores of each accepted design on each set, the oldest first. The diff of this file shows if a design is better or worse on each set. `accepted/<design>.json` holds the events of each accepted design, in the order of the answer-key rows.

Each entry pins its design:

- `pin.commit`: the commit that holds the detector.
- `pin.design`: the `Design` that the detector ran (`src/design.ts`). It holds the sha256 of the `plan.json` of its research round and the name of its embedding model.
- `metricsVersion`: the version of the metrics that made the scores (`METRICS_VERSION` in `metrics/metrics.ts`).

Before each run, the runner tells you if the design of the run is accepted. It compares the design with the design of each pin. The pin of design 3130 holds a same-publisher term with the weight 0, because that design had no such term.

To accept a design, run all sets with `--accept <design>`, for example `--accept 3152`. The runner refuses when:

- you name sets: an accepted design has scores on every set;
- `src/` has changes that are not committed;
- the scoreboard has the design name already: one name is one design;
- a report vanished or changed;
- the main score of a set is not higher than both baselines;
- a regression set is worse than the latest accepted design (see [Roles](#roles)).

The runner stops when the latest accepted design has scores of another metric version. Score that design again with the current metrics first.

When the metrics change, increase `METRICS_VERSION`, and score each accepted design again.

## The first entry: design 3130

Design 3130 was the frozen design of the package when the scoreboard started. The runner accepted it on 2026-10-27, at commit 73db0ed, with the old metrics (pair and B-cubed only). Its scores then were those of round #3130 where the protocol is the same:

- gvc: pair F0.5 0.868 and B-cubed F0.5 0.948, as round #3130 and `src/conformance.test.ts` measured.
- anthropic-outlets: B-cubed F0.5 0.812, as the live test of #3142 measured. The live test did not add the last headline-only report, so it scored the last day before its clustering.
- hlgd-test: B-cubed F0.5 0.787 and pair F0.5 0.008. Round #3130 measured 0.284 and 0.100 with its research code, which joined headline-only reports. The package never joins a headline-only report (ADR 0003), so most HLGD headlines stay alone.

On 2026-10-27, metric version 2 replaced those scores. The replica of research round #3152 (`feature-scorer-3152/scripts`) made the new scores and `accepted/3130.json` with the constants of commit 73db0ed. The replica gives the old scores of design 3130 on all six sets, to 3 decimals. It also gives the same events as the package for design 3152 on all six sets.
