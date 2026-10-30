# Evaluation of the relevance filter

The design of the filter comes from research round 6 of #3195, and `freeze/plan.json` froze it ([ADR 0002](../docs/adr/0002-the-design-is-frozen-by-research-round-6.md)). Round 10 made the reader rank instead of decide, and `freeze-ranking/plan.json` froze the ranker desc+kw and its exam rule ([ADR 0004](../docs/adr/0004-the-reader-ranks-and-does-not-decide-yes-or-no.md)). This folder runs both through the API of the package on the labelled sets of the research. It is not in the npm package and not in the build.

Run the evaluation before you change a step of the design, and run it again after the change.

## Cache

The repository holds no publisher text and no vector. The cache holds them, in `cache/` (Git ignores it):

- `cache/texts/<set>.json`: the title and the lead of each article. The keywords are matched in `title + ' ' + lead`, as in the research.
- `cache/vectors/<set>.sqlite`: a `Collection` of `@zukhruf/embeddings` with the frozen vector of each article.
- `cache/descriptions.json`: the vector of the description of each profile, embedded with `task: search result | query: <description>`.

EmbeddingGemma 2 Q8_0 on llama.cpp b11836 made every vector, with the vector text of event detection (`title: <title> | text: <title>\n<lead>`). No model runs in the eval. A stand-in model gives the frozen vector of each article id, so the text of each document in the collection is its id.

Write the cache one time from the research folder:

```sh
node eval/seed.ts ~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-profiles
```

| Set        | Vectors from                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| collection | `relevance-biology/pooled/vectors.json` (3,838), and `relevance-biology/round-1/vectors.json` for anthropic-outlets (816)                              |
| fresh      | `fresh/vectors.json`                                                                                                                                   |
| fresh-2    | `fresh-2/vectors.json`                                                                                                                                 |
| fresh-3    | `fresh-3/vectors.json`                                                                                                                                 |
| exam       | the vector cache of the event-detection eval (`deepmind-outlets.sqlite`), which embedded the 133 articles with the same model and the same vector text |

## Run it

```sh
npx nx run relevance-filtering:eval              # round 6 on the fresh slices (yes/no)
npx nx run relevance-filtering:eval -- ranking   # round 10 on fresh-3 (ranking)
npx nx run relevance-filtering:eval -- check     # the two implementation checks only
npx nx run relevance-filtering:eval -- daily     # round 11 on fresh-4 (best N a day)
npx nx run relevance-filtering:eval -- rehearse  # the ranking exam protocol on fresh-3
```

Each run does both implementation checks first. The scores go to `results/`.

### Implementation check

`check.ts` runs the record of `freeze/plan.json` through the package's `SimilarityScorer` and `ExpectedFThreshold({ beta: 0.5 })`: profile security, the fresh slice, product teaching with N = 10. It compares the result with two files in `implementation-check/`:

- `implementation-check.json`: the frozen record (sha256 `3daacace…`). The research used float64 vectors.
- `float32-reference.json`: the same record from the frozen research code on the vectors rounded to float32, as a collection stores them. `float32-reference.py` makes it from the research folder.

The check passes when the shown, taught and accepted articles and each decision are those of both files, and the probabilities and the threshold are those of the float32 reference to 1e-9. The package does not publish the binormal parameters (ADR 0005), so the check reads the probabilities, which the parameters give. On 2026-10-30 the package gave:

| Against               | Probabilities | Threshold | Decisions              |
| --------------------- | ------------- | --------- | ---------------------- |
| The frozen record     | 1.6e-7        | 1.5e-7    | The same, 196 accepted |
| The float32 reference | 2.2e-14       | 1.0e-15   | The same, 196 accepted |

### Ranking check

`ranking-check.ts` runs one unit of round 10 through `SimilarityScorer` and `scores.ranked()`: profile security, the pool protocol, N = 10. The order of all 1,617 articles of fresh-3 must equal the order of the research code in `implementation-check/ranking-reference.json`. `ranking-reference.py` makes that file from the research folder, with two orders: round 10 as it ran on float64 vectors, and the same code on float32 vectors, as a collection stores them. On 2026-10-30 the package gave both orders exactly. The exam needs this check.

### Round 10 on fresh-3

The window protocol teaches from the first 14 days of fresh-3 and ranks the rest. The pool protocol teaches from the collection, fresh and fresh-2 and ranks all of fresh-3. A unit (profile, N) is scored when its stream has at least 15 strict relevant articles. The score is the average precision (AP) of the ranking over the labelled articles (ambiguous left out), the mean over the units of a profile, and the mean over the scored profiles (MAP). The baselines are the keyword lists (matches first, newest first inside each group, equal dates by id) and newest first. The intervals are the topic bootstrap with `numpy.random.default_rng(31962)`.

On 2026-10-29 the package gave the MAP, the per-profile AP and the intervals of round 10 to 1e-15:

| Protocol            | desc+kw | keywordNarrow | keywordBroad | newest  | Interval vs keywordNarrow |
| ------------------- | ------- | ------------- | ------------ | ------- | ------------------------- |
| window (9 profiles) | 0.71667 | 0.51429       | 0.48591      | 0.06541 | [+0.0817, +0.2963]        |
| pool (11 profiles)  | 0.76571 | 0.47632       | 0.46183      | 0.05509 | [+0.2155, +0.3742]        |

### Round 11: the best N articles of a day

`daily [set] [--smoke]` implements `round-11/selection-rule.json` (sha256 `7d555bdf…`, #3308). The test slice is `set`, by default fresh-4 (2025-04 to 2025-06). The teaching pool is every other labelled slice: the collection, fresh, fresh-2 and fresh-3. The sha256 of each source file of the command is in `round-11/evaluator.sha256` of the research folder, written before the fresh-4 labels existed.

Implementation choices, fixed before the real labels (the rule leaves them open):

- **Training.** For each profile and N_teach in {5, 10}, product teaching from the pool (as round 10, pool order collection, fresh, fresh-2, fresh-3), then one `train` on the whole test slice. The binormal model is fitted on the whole slice, and each day is cut from the one order.
- **Days.** A day is the UTC publish date (`publishedAt` ISO, first 10 characters). The days are the days that hold an article of the slice. The ranker shows `ranked({ from: day 00:00:00.000Z, to: day 23:59:59.999Z }).slice(0, N_day)`.
- **Lists.** The keyword list shows the day's narrow matches (`keywords.json`, the research regex), newest first, equal times by id, at most N_day. Newest shows the day's N_day newest articles, equal times by id.
- **Recall (main).** For each profile, N_teach, N_day and day with at least one strict relevant article: relevant shown / strict relevant of the day. Mean over those days, then mean over the 6 (N_teach, N_day) cells, then macro mean over the scored profiles. A scored profile has at least 20 days with a strict relevant article in the test slice.
- **Precision.** Relevant shown / shown articles that are not ambiguous, over the days where the list shows at least one article that is not ambiguous. A cell with no such day has no precision and is left out of the mean over cells.
- **Empty days.** The share of the days of the slice where the list shows nothing.
- **Missed days.** The share of the days with a strict relevant article where the list shows none of them.
- **Equal count.** On each day, k_day = the number of articles that the keyword list showed that day for the N_day. The ranker is cut to k_day; recall and precision of the ranker and of the keyword list at k_day, as above.
- **Ambiguous articles** are shown or not like any article. They are never relevant, and never in the denominator of precision.
- **Pass.** The topic bootstrap of the research (2,000 replicates, `numpy.random.default_rng(31964)`, each interval from a fresh generator) on the per-profile differences of macro daily recall: the low end of (ranker - keyword) above -0.05 and the low end of (ranker - newest) above 0. The secondary metrics are reported only.
- **Smoke.** `--smoke` gives the test slice labels made in memory (for each profile in turn, `default_rng(9)` integers in [0, 100): below 6 relevant, 6 and 7 ambiguous), and never reads its label files. `daily fresh-3 --smoke` ran on 2026-10-29: 16 profiles scored, macro recall ranker 0.356, keyword 0.032, newest 0.360. With random labels the ranker is no better than newest, as it must be; the result was not a pass.

The results go to `results/daily-<set>.json` (`daily-smoke-<set>.json` for a smoke run).

**The score of fresh-4 (2026-10-29).** `daily fresh-4` ran one time, after all 25 files of `round-11/evaluator.sha256` matched. `round-11-result.json` holds the copy of the result. 8 profiles had at least 20 days with a relevant article (chips, security, funding, regulation, courts, open-models, coding, earnings). Macro daily recall: ranker 0.906, keyword 0.595, newest 0.360. The intervals are [+0.238, +0.388] for (ranker - keyword) and [+0.458, +0.636] for (ranker - newest), so the best-N-a-day list **passes**. Secondary: precision 0.188 for the ranker, 0.622 for the keyword list and 0.065 for newest; the keyword list showed nothing on 50.1% of the days and missed 27.5% of the days with a relevant article (ranker 4.7%, newest 52.5%); at the keyword list's count k_day, the ranker gives recall 0.634 and precision 0.657 against 0.595 and 0.622.

### Round 6 on the fresh slices

Each slice teaches from the articles of its first 14 days and decides on the rest. For each profile and each N in {5, 10}, the reader shows the N articles most similar to the description and the N most similar matches of the narrow keyword. The answer key answers: relevant is a yes, not relevant is a no, and an ambiguous article is skipped. A profile is scored on a slice when the rest of the slice holds at least 15 strict relevant articles.

The scores are those of the research code (round-2 `evaluate.py`, `metric_row`): T11F (F-measure with beta 0.5, TREC-11), and the Brier skill against the base rate of the stream. The macro score is the mean over the scored profiles. The interval of (design - baseline) is the topic bootstrap of the research with `numpy.random.default_rng(31957)`, and `numpy-random.ts` draws the same integers as numpy.

On 2026-10-29 the package gave the numbers of round 6: macro T11F 0.7014896592253096 against keywordNarrow 0.6559484434821066, interval [-0.0189, +0.1180], macro Brier skill +0.512.

### Rehearsal

`rehearse` runs the ranking exam protocol with fresh-3 as the stream and the collection, fresh and fresh-2 as the teaching pool. It gives the verdict of the rule on that set, and reads no exam label. It shows that the exam code runs. On 2026-10-29 it gave MAP 0.738 against keywordNarrow 0.459 (interval [+0.225, +0.323]) on 15 profiles, and the result pass. fresh-3 served rounds 9 and 10, so this is no evidence for the exam.

## Exam

`--exam` scores the sealed exam one time, with the ranking verdict rule of `freeze-ranking/plan.json` (`examVerdictRule`). It refuses to run unless the ranking check passes. The teaching pool is the collection, fresh, fresh-2 and fresh-3, in that order for equal similarities. The stream is the 133 deepmind-outlets articles.

- The profiles are every profile with at least 3 strict relevant exam articles. Biology counts, with its labels in `biology-labels.json`.
- The AP of each profile is the mean over N in {5, 10}. The macro MAP is the mean over the profiles. The baselines are keywordNarrow, keywordBroad and newest first.
- The interval is a paired article bootstrap: 2,000 replicates with `numpy.random.default_rng(31963)`, in two strata: the articles that are strict relevant to a verdict profile, and the other articles. Each stratum draws as many articles as it holds. One weight for each exam article is shared by every profile, N and list. An article drawn w times takes w ranks next to each other in each list, and an article that is not drawn takes none. A profile whose relevant articles a replicate does not draw has no AP, and is left out of the MAP of that replicate.
- The ranker passes when the low end of its interval against keywordNarrow is above -0.05, and its intervals against keywordBroad and newest lie entirely above 0.

The run writes `results/exam.json` and the first-scored date into `sets/exam/set.json`. After that, `--exam` refuses the set (`roles.ts`), and the exam is a regression set.

### The score of 2026-10-29

The exam was scored one time, on 2026-10-29T12:47:21Z, after both checks passed in the same run. `exam-result.json` holds the copy of `results/exam.json`. The verdict is **pass**.

| Profile     | desc+kw | keywordNarrow | keywordBroad | newest |
| ----------- | ------- | ------------- | ------------ | ------ |
| biology     | 0.790   | 0.579         | 0.380        | 0.134  |
| funding     | 0.875   | 0.759         | 0.525        | 0.023  |
| robotics    | 0.967   | 0.915         | 0.877        | 0.038  |
| safety      | 0.803   | 0.683         | 0.683        | 0.095  |
| open-models | 0.901   | 0.310         | 0.787        | 0.085  |
| MAP         | 0.867   | 0.649         | 0.650        | 0.075  |

The 95% intervals of (desc+kw - baseline) are [+0.105, +0.331] against keywordNarrow, [+0.042, +0.342] against keywordBroad and [+0.656, +0.877] against newest. Only 5 profiles had at least 3 strict relevant exam articles, so the interval rests on few profiles and 133 articles. The exam is a regression set from now on. The yes/no exam rule of `freeze/plan.json` is not in the runner any more: the ranking rule replaced it, and an exam is scored one time only.

## Sets

Each folder in `sets/` is one set. `articles.json` holds the queue number, the id and the publish date of each article. The label files are copies of the frozen research files, and `set.json` holds the sha256 of each one.

| Set        | Articles | Role                                                  | Labels                                                                                     |
| ---------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| collection | 4,654    | training (teaching pool of the exam)                  | `labels.json`, sha256 `69a540c1…`                                                          |
| fresh      | 1,675    | training                                              | `labels.json`, sha256 `a2802bbe…`                                                          |
| fresh-2    | 1,735    | training                                              | `labels.json`, sha256 `d123cde2…`                                                          |
| fresh-3    | 1,617    | training (rounds 9 and 10; teaching pool of the exam) | `labels.json`, sha256 `a5a871b6…`                                                          |
| exam       | 133      | exam, never scored                                    | `labels.jsonl` (sealed, sha256 `2bba5406…`) and `biology-labels.json` (sha256 `4cb90b03…`) |

`profiles.json`, `profiles.md` and `keywords.json` are the profiles and the keyword baselines of the answer key. A design sees only the id and the description of a profile.

### Roles

- **Training**: a design may be tuned on the set.
- **Exam**: no design has seen the set. The runner scores it one time only, with `--exam`, as the test of the frozen design. It then writes the first-scored date into `set.json`, and the set is a regression set from then on.

When you find a wrong label, fix it in its own commit, give the reason in the commit message, and write the new sha256 into `set.json`. The runner tells you the hash.
