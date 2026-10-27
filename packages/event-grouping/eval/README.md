# Evaluation of the event detector

The parameters of the detector come from research round #3130 ([ADR 0001](../docs/adr/0001-the-parameters-are-frozen-by-research-round-3130.md)). This folder lets you measure the detector again, on the same labelled sets, before and after a change. It is not in the npm package and not in the build.

Run the evaluation before you change a parameter, the lead rule, the similarity source or the model. Then run it again after the change.

## Run it

The evaluation needs the embedding model of round #3130: EmbeddingGemma 2 Q8_0 on llama.cpp b11836. CI does not have the model, so the `eval` target runs only on a machine with the model. CI does not run it.

1. Start the embedding server with the arguments of round #3130:

   ```sh
   llama-server -m embeddinggemma-2-Q8_0.gguf --alias embeddinggemma-2 \
     --host 127.0.0.1 --port 8096 -c 8192 -np 1 -t 2 -tb 2 -b 8192 -ub 2048 --embedding
   ```

2. Run the evaluation:

   ```sh
   EVAL_EMBEDDING_URL=http://127.0.0.1:8096/v1 npx nx run event-grouping:eval
   ```

3. Stop the server.

Give set names to score only those sets, for example `npx nx run event-grouping:eval -- gvc hlgd-test`. `--help` shows the options.

Before it scores a set, the runner embeds a probe text. If the vector is not the vector of round #3130 (`embedding-probe.json`), the runner stops. Thus a server with another model or another quantization cannot give scores.

## What a run does

For each set, the runner does these steps:

1. It reads the answer key and checks its hash against `set.json`.
2. It gets the text of each report (see [Texts](#texts)).
3. It gives the reports to a new `EventDetector` in an in-memory database, as a host does: one `add` for each publish day, in the order of the publish dates. Reports with equal dates keep the order of the answer key.
4. After the last day, it adds one headline-only report of the next day. This makes the detector cluster the last window again, so the events of the last day are final. The headline-only report never joins an event (ADR 0003).
5. It scores the events against the answer key and writes `results/<set>.json`.

The vectors are in `cache/vectors/<set>.sqlite`, through the `Collection` of `@zukhruf/embeddings`. The collection embeds a lead again only when its text or the model name changed. Thus a second run embeds nothing.

Each result has these scores:

- Pair precision, recall and F0.5. A pair is two reports. F0.5 counts precision two times as much as recall.
- B-cubed precision, recall and F0.5.
- Pair scores for pairs of two publishers and pairs of one publisher, when the set has publishers.
- The scores without the ambiguous reports, when the set has ambiguous reports.
- The time of each `add`. It includes the embedding only of the leads that are not in the vector cache, so a second run measures the grouping alone.
- Each false join and each false split, with the titles of the reports.

The runner prints the change of each score against the latest accepted design in `scoreboard.json`.

## Sets

Each folder in `sets/` is one set. It has two files:

- `answer-key.json`: one row for each report: `id`, `source`, `publishedAt`, `publisher` (when known), `event`, `ambiguous` (when the annotator was not sure) and `textSha256`. It has no publisher text.
- `set.json`: the role, the freeze date, the first-scored date, the hash of the labels, the annotator, the boundary rule, the source with its licence and attribution, and the known weaknesses of the labels.

| Set               | Reports | Events | Role       | Text                                             |
| ----------------- | ------- | ------ | ---------- | ------------------------------------------------ |
| anthropic-outlets | 816     | 618    | training   | Web pages of 6 publishers, April to October 2026 |
| ecbplus           | 982     | 86     | training   | ECB+ corpus, rebuilt from its tokens             |
| dev2938           | 217     | 209    | training   | Web pages of 12 publishers, October 2026         |
| fresh2957         | 48      | 23     | training   | WCEP-10 rows on Hugging Face                     |
| gvc               | 509     | 241    | regression | Gun Violence Corpus, rebuilt from its tokens     |
| hlgd-test         | 286     | 125    | regression | HLGD headlines                                   |

### Roles

- **Training**: you can tune a design on this set.
- **Regression**: a new design must not have a lower pair F0.5 or B-cubed F0.5 on this set than the latest accepted design. Do not tune on it.
- **Exam**: no design has seen this set. The runner scores it one time only, with `--exam`, as the test of a frozen design. It then writes the first-scored date into `set.json`, and the set is a regression set from then on. The runner refuses `--exam` on a set that has a first-scored date.

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

## Scoreboard

`scoreboard.json` holds the scores of each accepted design on each set, the oldest first. The diff of this file shows if a design is better or worse on each set.

To accept a design, run all sets with `--accept <design>`, for example `--accept 3130`. The runner refuses when:

- you name sets: an accepted design has scores on every set;
- a report vanished or changed;
- a regression set has a lower pair F0.5 or B-cubed F0.5 than the latest accepted design on the same labels.

## The first entry: design 3130

Design 3130 is the frozen design of the package. The run of 2026-10-27 gives the scores of round #3130 where the protocol is the same:

- gvc: pair F0.5 0.868 and B-cubed F0.5 0.948, as round #3130 and `src/conformance.test.ts` measured.
- anthropic-outlets: B-cubed F0.5 0.812, as the live test of #3142 measured. The pair scores are P 0.306 and R 0.313; the live test had P 0.303 and R 0.309. The live test did not add the last headline-only report, so it scored the last day before its clustering. Without that report, the partition is the partition of the live test.
- hlgd-test: B-cubed F0.5 0.787 and pair F0.5 0.008. Round #3130 measured 0.284 and 0.100 with its research code, which joined headline-only reports. The package never joins a headline-only report (ADR 0003), so most HLGD headlines stay alone.
