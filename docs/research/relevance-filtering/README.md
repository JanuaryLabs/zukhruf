# Relevance answer key: 16 news profiles

Second answer key for `@zukhruf/relevance-filtering` (zukhruf backlog #3195), and
research round 2. Round 1 (`../relevance-biology/`) used one profile, Biology,
and 7 relevant articles could not separate designs. Round 2 follows the
multi-topic standard: for a fixed judging effort, many topics judged shallowly
compare systems more reliably than one topic judged deeply (Sanderson & Zobel,
SIGIR 2005; Carterette et al., SIGIR 2008). TREC-11 Filtering used 100 topics.
The user chose this route on 2026-10-28 and left the choice of profiles to the
agent.

## Files

| File | Content |
| --- | --- |
| `profiles.json` | 16 profiles: id, title, description (the one sentence a design sees), narrative, not-relevant cases, ambiguous cases, and the inclusion rule. Biology is copied word for word from `../relevance-biology/rule.md`. sha256 `a5932290…`, frozen 2026-10-28T08:11:31Z, before any article was read. |
| `profiles.md` | The annotators' rule, rendered from `profiles.json` by `render-profiles.py`. sha256 `964812c9…`, frozen with it. |
| `keywords.json` | Keyword baselines per profile (narrow, broad). Annotators never saw it. sha256 `e4931aad…`, frozen with the profiles. |
| `collection/items.json`, `collection/build.py` | The collection: The Decoder + SiliconANGLE stream (3,838) and anthropic-outlets (816), 2026-04-01 to 2026-10-26; shuffled queue numbers (seed 31951). The exam queue `exam/items.json` (deepmind-outlets, 133). |
| `tools/` | Annotator tools: `show.py`, `body.py`, `put.py` (checks every line), `check.py`. |
| `labels/` | Main pass: 8 blind queues and their JSON-lines labels. |
| `labels.json` | The merged main pass, one row per article. sha256 `69a540c1…`, frozen 2026-10-28T08:21:46Z. |
| `agreement/` | Second, independent annotator on 400 random articles; `agreement.py`, `agreement.json`. |
| `exam/labels.jsonl` | The 15 non-Biology profiles on deepmind-outlets. SEALED: sha256 `2bba5406…`, frozen 2026-10-28T08:16:12Z by its annotator; the research lead has not read it. Biology's exam stays `../relevance-biology/exam/labels.json`. |
| `round-2/` | `selection-rule.json` (sha256 `d4913ede…`, frozen 08:16:54Z, before any label was read), `descriptions.json` (probe cosine 1; Biology equals round 1), `evaluate.py` (sha256 `67ef588a…`, frozen with the labels), `results.json`, `summary.py`. |
| `freeze.py`, `merge.py`, `render-profiles.py` | Hashing and merging. |

## Method

- Annotators: Claude (Opus 5.5), one per queue, blind (no model output, no keyword list, no earlier labels), every article read, body read when the lead was unclear. Values: true, null (ambiguous, with alternative and reason), false (omitted).
- Each article has a label for every profile (exhaustive, no pooling), so every score is exact on the collection.
- Teaching period 2026-04-01 to 2026-05-31; test period 2026-06-01 to 2026-10-26 (TREC-11 also teaches from the earliest part).

## Agreement (400 articles, `agreement/agreement.json`)

Cohen's kappa, relevant vs not: 0.89 to 1.00 for 14 profiles, 0.66 for jobs;
Biology has no relevant article in the sample. Almost every disagreement is
true against null (ambiguous). Exactly one true against false in 6,400
judgments (coding). Biology against the earlier keys: no true/false flip
(anthropic-outlets kappa 0.80, pooled 0.80); the differences are ambiguity calls.

Known labelling patterns (from the annotators' reports): chip-company results
and compute deals that name chips are mostly `chips: null`; safety statements
and opinion with no research result are `safety: null`; funding articles that
describe a product often carry the product profile as null.

## Results

| Round | Rule (frozen) | Result |
| --- | --- | --- |
| 2 | `round-2/selection-rule.json` `d4913ede…` | No design. Narrow keyword 0.569 macro T11F (11 scored profiles); best rocchio-q0\|binormal 0.538, desc\|binormal 0.532 (only positive Brier skill, +0.111). Binormal doubles every method over Platt. `round-2/plan.json` `71336455…`. |
| 3 | `round-3/selection-rule.json` `f846855f…` | No design. Fused dense + tf-idf Rocchio 0.557 (ties keyword: −0.080 to +0.052), best ranking (AP) on most profiles, but the binormal threshold over-accepts on zero-inflated lexical scores. `round-3/plan.json` `1084578a…`. |

Record: zukhruf `docs/research/relevance-filtering.md` (commit 62617f4), limitations 9 to 12.
Scored profiles (>= 10 teaching and >= 20 test relevant): chips, security, funding, regulation, courts, robotics, safety, open-models, jobs, coding, earnings. Not scored: biology (2 teaching from the collection, taught from training-extra; 12 test), energy, quantum, health, education.
| 4 | `round-4/selection-rule.json` `ead2b9f6…` | No design, closest yet. Fresh test set: 1,675 articles from 2026-01 to 2026-03 (`fresh/`, labels `a2802bbe…`). The reader's keywords as naive-Bayes evidence: desc\|binormal+kw 0.733 against keyword 0.679, Brier skill +0.475; interval against the keyword [−0.012, +0.118] includes 0. Wins 8 of 11 profiles; loses regulation (unstable fit) and robotics. `round-4/plan.json`. |
| 5 | `round-5/selection-rule.json` `11faab82…` | No design. Replication on a second fresh slice (2025-10 to 2025-12, 1,735 articles, `fresh-2/` labels `d123cde2…`): desc\|binormal+kw 0.697 against keyword 0.644, interval [−0.040, +0.137] (same +0.05 lead as round 4). The EM-lambda guard is worse (0.592). `round-5/plan.json`. |
| 6 | `round-6/selection-rule.json` `0d145514…` | No design by the gate. Product-style teaching (yes/no on the reader's top matches in the first 14 days of each fresh slice): desc\|binormal+kw 0.701 against keyword 0.656, interval [−0.019, +0.118], Brier skill +0.512; non-inferior at margin 0.05. Third test with the same +0.05 lead. `round-6/plan.json`. |
| 7 | `round-7/selection-rule.json` `c615b539…` | No design. Truncated-likelihood binormal (Zhang & Callan 2001) won both pool protocols (0.711, 0.742) and missed the window protocol (lower bound −0.061). |
| 8 | `round-8/selection-rule.json` `6249268c…` | No design. Ordered components (mu1 = mu0 + exp(delta)) relabelled the degenerate peak; failed all three protocols. |
| 9 | `round-9/selection-rule.json` `6909823c…` | No design, confirmation on fresh-3 (2025-07..09, labels `a5a871b6…`): every yes/no design lost to or tied the keyword. Led to the ranked reader. |
| 10 | `round-10/selection-rule.json` `37952976…` | PASS: ranker desc+kw MAP 0.717 / 0.766 vs keyword 0.514 / 0.476. Frozen in `freeze-ranking/plan.json` (`c43a44d0…`); sealed exam passed through the package (MAP 0.867 vs 0.649, zukhruf 31698d2). |
| 11 | `round-11/selection-rule.json` `7d555bdf…` | PASS (#3308): on fresh-4 (2025-04..06, labels `8e62624c…`) the best-N-a-day list shows 91% of each day's relevant articles vs 59% for a keyword list (zukhruf afdbb28). |
| 12 | `round-12/selection-rule.json` `5728b7ba…` | No ranker (#3383). fresh-5 (2025-01..03, 1,370 articles, four blind annotators, labels `187918bd…`): MAP desc+kw 0.782, hybrid 0.763 (interval vs desc+kw [−0.041, −0.005]), hybrid-rocchio 0.788 ([−0.050, +0.073]); daily recall 0.899 / 0.890 / 0.900. desc+kw stays. `round-12/plan.json` `090198db…`. |
| 13 | `round-13/selection-rule.json` `d9e0d341…` | PASS (#3383): Liquid AI d1-2B (Mac mini, /v1/systemone, zero-shot, answers `a86a1235…` frozen before the labels) MAP 0.924 vs desc+kw 0.782 ([+0.049, +0.298]), daily recall 0.957 vs 0.899 ([+0.013, +0.125]); d1+kw 0.876 is worse than d1. p ≥ 0.5 T11F 0.894 vs keyword 0.679 ([+0.083, +0.369]), Brier skill +0.726. `round-13/plan.json` `7859cb7c…`. |
| 14 | `round-14/selection-rule.json` `08e4956e…` | HOLDS (#3383, limitation 16): four blind Codex (GPT-family) annotators relabelled fresh-5 (`round-14/labels-gpt.json` `4bd63834…`); d1 MAP 0.808 vs desc+kw 0.634 ([+0.094, +0.278], 12 profiles, d1 better on all 12), daily recall 0.941 vs 0.884 ([+0.013, +0.114]). The GPT key draws wider boundaries; d1's Brier skill falls to +0.356. `round-14/plan.json` `6939f5f8…`. |
| 15 | `round-15/selection-rule.json` `3c622f79…`, `round-15/exploration-arm.json` `6915da70…` | NO RECALIBRATION (#3421). fresh-6 (2024-10..12, 1,578 articles: SiliconANGLE 1,188, The Decoder 390; d1 answers `89855665…` frozen before the labels; four blind annotators, labels `9d8a3e8a…`; 9 scored profiles). Raw d1 at p ≥ 1/3, window / pool: macro T11SU 0.784 / 0.788 (keyword 0.593 / 0.607), Brier skill +0.585 / +0.577, MAP 0.936 / 0.932 (check). Frozen arm: shift 0.840 ([−0.047, +0.231]) / 0.819 ([−0.002, +0.095]), platt 0.743 / 0.825; shift fell back to raw (no taught "no") in 6 of 18 window and 16 of 18 pool units. Exploration arm, no fallbacks: shift 0.805 / 0.703 ([−0.183, +0.009]), platt 0.774 / 0.605 ([−0.301, −0.073]). Thresholds stay on raw d1. `round-15/results.json` `93f4a446…`. |
| 16 | `round-16/selection-rule.json` `ad38cb00…` (last recalibration round) | EXPLORATION ARM PASSES (#3523): platt-map, the MAP fit of p = logistic(a·logit(p_d1) + b) with (a − 1, b) ~ N(0, I), hard targets. fresh-7 (2024-07..09, 1,494 articles: SiliconANGLE 1,117, The Decoder 377, equal to the WordPress API counts; d1 answers `ed14d301…` frozen before the labels; four blind annotators, labels `7fdedd07…`; 8 window / 9 pool scored profiles). Gate in both protocols: T11SU interval lower > −0.02, Brier skill lower > −0.05, T11SU gain > 0. Exploration platt-map: window 0.836 vs raw 0.767 ([−0.015, +0.201], Brier [+0.008, +0.249]), pool 0.812 vs 0.776 ([−0.009, +0.103], Brier [+0.036, +0.201]); it beats shift-map in both. Frozen arm: platt-map passes pool ([−0.003, +0.022]) but not window ([−0.042, +0.195], Brier [−0.139, +0.144]); shift-map fails, in pool 0.461 (all-relevant taught units push b up). Keyword 0.652 / 0.648; raw MAP 0.917. The user saw the design (the host shows some low-ranked articles) and the adapter API, and chose not to build it now (2026-11-01): the fit keeps the order, and the reader shows a ranking, not yes/no. `round-16/results.json` `42ccbaea…`, `round-16/evaluate.py` `3fe37c57…`. |

Notes (2026-10-30): zukhruf 71fbd33 moved `packages/event-grouping` to `packages/information-filtering/event-detection`, so the copied scripts in `fresh/` to `fresh-4/` that import the old path no longer run (fresh-5's scripts use the new path). The EmbeddingGemma 2 Q8_0 GGUF moved from `embedding-heldout-2938/models/` to `~/.cache/huggingface/hub/models--ggml-org--embeddinggemma-2-GGUF/snapshots/58faf909…/` (same sha256).

Notes (2026-11-01, round 15): six Decoder crawls of fresh-6 did not finish as one full_refresh/overwrite copy, which commits nothing on a partial failure (disk full twice, ENETUNREACH twice after the Mac slept, crawl.ts's own 4 h cap, and run 6 stopped because the HTTP cache gave no 304s). Run 7 copied with syncMode incremental and destinationSyncMode append_dedup: elt commits at each STATE, so a rerun resumes from the checkpointed frontier. Only the sync mode changed; prepare.ts keeps the same period and exclusions. The crawl ran on a peer's uncommitted elt web-source build, so `fresh-6/compare-decoder.ts` compared it with fresh-5: 4,086 of 4,092 shared Decoder pages extract identically, and the 6 differences are 2026 posts that the site edited, none of them in fresh-6 (`fresh-6/compare-decoder.json`). d1 ran on the Mac mini (LiquidAI/d1-2B-GGUF:Q8_0, llama.cpp b11960, automatic slots, parallel −1); `round-15/collect.py` sent one request at a time, median 3.52 s per article. The four annotators took 4 to 5 minutes each in batches of 30, as fresh-5's did. Annotators 3 and 4 grepped six single bodies (q1183, q1307, q380, q632, q1284, q1456) for words about released weights, after they read the title and lead; fresh-5's annotators did this 1 to 2 times each. Information only, calculated after the run: raw d1 accepts 124 to 144 coding articles for 25 to 28 relevant (T11SU 0), the wide boundary of round 14's GPT key; 67% of d1's fresh-6 probabilities are below 0.05, under Platt's smoothed target 1/(n+2) for a "no", and 13 of 18 exploration-pool shift intercepts are positive.

Notes (2026-11-01, round 16): the SiliconANGLE crawl ran on elt 4d63590f (#3505, per-origin pacing at 1 s) after the peer's commit and build, in 2,370 s (2,253 responses, all 200); the Decoder rows of the period come from fresh-6's crawl store, which holds every Decoder post modified from 2024-03-15. Extraction parity: 62 of 62 SiliconANGLE articles of 2024-10-01..03 extract identically to fresh-6 (`fresh-7/compare-siliconangle.json`). Each WordPress article costs a second request to its `/wp-json/` record (elt #3531). Two completeness fixes before `fresh-7/articles.json` was frozen: (1) prepare.ts dropped the query from its URL key, so every WordPress shortlink (`?p=ID`) had the same key and all but the first were skipped without a report; a URL with no path now keeps its query, and the Decoder post `?p=16743` (2024-08-21) is in fresh-7; (2) SiliconANGLE URLs carry the US date and the period is UTC, so the US evening of 2024-06-30 is 2024-07-01 UTC; a resume with a wider include fetched nothing (its checkpoint had every sitemap read), so `fresh-7/edge` holds those posts (one kept, 01:44 UTC). Limitations of earlier slices from the same two causes, not corrected because those slices are scored: fresh-5 lacks the Decoder shortlink post `?p=20377` (2025-01-09), and fresh-6 lacks one SiliconANGLE post at its UTC start (2024-10-01 00:12 UTC). d1: Q8_0 on the Mac mini, llama.cpp b11960, one request at a time, median 3.61 s per article, 0 failed. The annotators took 4 to 5 minutes each; annotators 1 and 4 grepped a few single bodies for words about released weights, as in fresh-5 and fresh-6. Information only, after the run: in the exploration arm platt-map fits a slope a of 1.2 to 2.0 on most profiles (d1's probabilities are less extreme than this key), and the largest T11SU gains are coding (+0.486 window, +0.288 pool) and courts (+0.095, +0.072); open models (−0.050, −0.020) and earnings (−0.040, −0.024) lose a little. The results' verdict string joins the prefix "only the exploration arm passes" to the rule's whole 'then' text; the `chosen` fields are the verdict.
