# Evaluation of the relevance filter

The design of the filter comes from research round 6 of #3195, and `freeze/plan.json` froze it ([ADR 0002](../docs/adr/0002-the-design-is-frozen-by-research-round-6.md)). This folder runs that design through the API of the package on the labelled sets of the research. It is not in the npm package and not in the build.

Run the evaluation before you change a step of the design, and run it again after the change.

## Cache

The repository holds no publisher text and no vector. The cache holds them, in `cache/` (Git ignores it):

- `cache/texts/<set>.json`: the title and the lead of each article. The keywords are matched in `title + ' ' + lead`, as in the research.
- `cache/vectors/<set>.sqlite`: a `Collection` of `@zukhruf/embeddings` with the frozen vector of each article.
- `cache/descriptions.json`: the vector of the description of each profile, embedded with `task: search result | query: <description>`.

EmbeddingGemma 2 Q8_0 on llama.cpp b11836 made every vector, with the vector text of event grouping (`title: <title> | text: <title>\n<lead>`). No model runs in the eval. A stand-in model gives the frozen vector of each article id, so the text of each document in the collection is its id.

Write the cache one time from the research folder:

```sh
node eval/seed.ts ~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-profiles
```

| Set        | Vectors from                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| collection | `relevance-biology/pooled/vectors.json` (3,838), and `relevance-biology/round-1/vectors.json` for anthropic-outlets (816)                             |
| fresh      | `fresh/vectors.json`                                                                                                                                  |
| fresh-2    | `fresh-2/vectors.json`                                                                                                                                |
| exam       | the vector cache of the event-grouping eval (`deepmind-outlets.sqlite`), which embedded the 133 articles with the same model and the same vector text |

## Run it

```sh
npx nx run relevance-filtering:eval              # round 6 on the fresh slices
npx nx run relevance-filtering:eval -- check     # the implementation check only
npx nx run relevance-filtering:eval -- rehearse  # the exam protocol on a development set
```

Each run does the implementation check first. The scores go to `results/`.

### Implementation check

`check.ts` runs the record of `freeze/plan.json` through the package: profile security, the fresh slice, product teaching with N = 10. It compares the result with two files in `implementation-check/`:

- `implementation-check.json`: the frozen record (sha256 `3daacace…`). The research used float64 vectors.
- `float32-reference.json`: the same record from the frozen research code on the vectors rounded to float32, as a collection stores them. `float32-reference.py` makes it from the research folder.

The check passes when the shown, taught and accepted articles and each decision are those of both files, and the probabilities, the threshold and the binormal parameters are those of the float32 reference to 1e-9. On 2026-10-29 the package gave:

| Against               | Probabilities | Threshold | Binormal parameters | Decisions              |
| --------------------- | ------------- | --------- | ------------------- | ---------------------- |
| The frozen record     | 1.6e-7        | 1.5e-7    | 1.5e-8              | The same, 196 accepted |
| The float32 reference | 2.2e-14       | 1.0e-15   | 2.0e-15             | The same, 196 accepted |

### Round 6 on the fresh slices

Each slice teaches from the articles of its first 14 days and decides on the rest. For each profile and each N in {5, 10}, the reader shows the N articles most similar to the description and the N most similar matches of the narrow keyword. The answer key answers: relevant is a yes, not relevant is a no, and an ambiguous article is skipped. A profile is scored on a slice when the rest of the slice holds at least 15 strict relevant articles.

The scores are those of the research code (round-2 `evaluate.py`, `metric_row`): T11F (F-measure with beta 0.5, TREC-11), and the Brier skill against the base rate of the stream. The macro score is the mean over the scored profiles. The interval of (design - baseline) is the topic bootstrap of the research with `numpy.random.default_rng(31957)`, and `numpy-random.ts` draws the same integers as numpy.

On 2026-10-29 the package gave the numbers of round 6: macro T11F 0.7014896592253096 against keywordNarrow 0.6559484434821066, interval [-0.0189, +0.1180], macro Brier skill +0.512.

### Rehearsal

`rehearse` runs the exam protocol with fresh-2 as the stream and the collection and fresh as the teaching pool. It gives no verdict, and it reads no exam label. It shows that the exam code runs, and how the protocol behaves.

On 2026-10-29 it gave macro T11F 0.376 against keywordNarrow 0.524 and Brier skill -0.019. The cause is the teaching: the top N articles of a pool of 6,300 are the most similar of all, so the taught relevant similarities are far above the relevant articles of the stream. The binormal fit then puts the relevant component at about 3 to 4.4 standard deviations, with the share at its lower bound 1/n. For security, the filter accepted no article. The frozen research code gives the same numbers on the same data. Round 6 taught from 14 days of the same slice, about 250 articles.

## Exam

`--exam` scores the sealed exam one time, with the verdict rule of `freeze/plan.json` (`examVerdictRule`). It needs a passing implementation check. The teaching pool is the collection, fresh and fresh-2. The stream is the 133 deepmind-outlets articles. The verdict profiles are the profiles with at least 3 strict relevant exam articles, Biology apart.

- The macro score is the mean over the verdict profiles of the T11F, averaged over N in {5, 10}. The Brier skill is per profile, against the exam base rate.
- The interval is a paired, label-stratified article bootstrap: 2,000 replicates with `numpy.random.default_rng(31958)`. One weight for each exam article is shared by every profile, N and design. The plan does not name the strata for many profiles. The eval uses the strata of the round-1 bootstrap, generalised: the articles that are strict relevant to a verdict profile, and the other articles. Each stratum draws as many articles as it holds. An ambiguous article is left out of the counts of its profile only.
- The design passes when the low end of its interval against keywordNarrow is above -0.05, its intervals against keywordBroad, alwaysNo and alwaysYes lie above 0, and its macro Brier skill is above 0.
- Biology is reported with the same protocol, and it does not decide the verdict. The rule of the round-1 exam of Biology is not in this eval.

The run writes `results/exam.json` and the first-scored date into `sets/exam/set.json`. After that, `--exam` refuses the set (`roles.ts`), and the exam is a regression set.

## Sets

Each folder in `sets/` is one set. `articles.json` holds the queue number, the id and the publish date of each article. The label files are copies of the frozen research files, and `set.json` holds the sha256 of each one.

| Set        | Articles | Role                                 | Labels                                                                                     |
| ---------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| collection | 4,654    | training (teaching pool of the exam) | `labels.json`, sha256 `69a540c1…`                                                          |
| fresh      | 1,675    | training                             | `labels.json`, sha256 `a2802bbe…`                                                          |
| fresh-2    | 1,735    | training                             | `labels.json`, sha256 `d123cde2…`                                                          |
| exam       | 133      | exam, never scored                   | `labels.jsonl` (sealed, sha256 `2bba5406…`) and `biology-labels.json` (sha256 `4cb90b03…`) |

`profiles.json`, `profiles.md` and `keywords.json` are the profiles and the keyword baselines of the answer key. A design sees only the id and the description of a profile.

### Roles

- **Training**: a design may be tuned on the set.
- **Exam**: no design has seen the set. The runner scores it one time only, with `--exam`, as the test of the frozen design. It then writes the first-scored date into `set.json`, and the set is a regression set from then on.

When you find a wrong label, fix it in its own commit, give the reason in the commit message, and write the new sha256 into `set.json`. The runner tells you the hash.
