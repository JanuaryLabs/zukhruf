# Relevance filtering: research record

This record keeps what the research for relevance filtering found, before the package exists. The research asks one question: can a cheap program tell if a new article matches a reader's standing interest, and give a probability that the reader can trust? The planned package is `@zukhruf/relevance-filtering`, in `packages/information-filtering/` (backlog #3195). Event detection (`docs/research/event-grouping.md`) is the other half of the reader. Event detection removes duplicates. Relevance filtering keeps what matches the reader's interests.

Read this record before you change the design, add a profile type, or start a new evaluation. Add the result of each new round to this record.

Status on 2026-10-29: DONE. The ranker desc+kw passed the sealed exam (MAP 0.867 against the keyword list's 0.649, interval of the difference +0.105 to +0.331; commit 31698d2). The package `@zukhruf/relevance-filtering` ranks each profile's stream through `ranked()`; its yes/no threshold is kept but not recommended. The exam is a regression set now.

## Words in this record

| Word        | Meaning                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile     | One standing interest of a reader, for example "Biology". It has a name, one sentence, and the articles that the reader marked relevant or not relevant. TREC calls it a profile. |
| Relevant    | The article matches the profile under the written rule.                                                                                                                           |
| Base rate   | The share of relevant articles in a stream. In a real news feed, Biology is about 1 article in 200.                                                                               |
| Calibration | A probability is calibrated when 80% means relevant about 8 times in 10.                                                                                                          |
| Brier score | The mean squared error of the probabilities. Lower is better.                                                                                                                     |
| F0.5        | A score that counts precision two times as much as recall. TREC-11 used it for filtering (T11F).                                                                                  |
| Pooling     | The TREC method to label a large stream: label the articles that some method or a keyword search nominates, and a random sample of the rest.                                      |
| Macro mean  | The mean of a score over profiles, each profile with the same weight. TREC reports filtering this way.                                                                            |
| Binormal    | A calibration that fits two bell curves to the scores of the stream: one for relevant articles, one for the rest. The probability is the share of the relevant curve.             |

## The data

All files are on the maintainer's Mac in `~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-biology/`. The labelling rule (`rule.md`, sha256 `7e6aa431…`) was frozen before the first label.

| Set                                                       | Articles | Relevant | Ambiguous | Role                                 |
| --------------------------------------------------------- | -------- | -------- | --------- | ------------------------------------ |
| anthropic-outlets (AI news)                               | 816      | 4        | 11        | Training, realistic base rate (0.5%) |
| training-extra (MIT News, Arc Institute, Isomorphic Labs) | 83       | 42       | 13        | Training, enriched base rate (51%)   |
| deepmind-outlets                                          | 133      | 11       | 8         | Exam, sealed                         |
| pooled (The Decoder + SiliconANGLE)                       | 3,838    | 7        | 10        | Training, realistic base rate (0.2%) |

One annotator (an AI model) labelled every set above. No second annotator checked those labels.

From round 2, a second answer key holds 16 profiles in `relevance-profiles/` (beside `relevance-biology/`). The profiles are Biology and 15 that the agent chose for an AI-news reader: chips, security, funding, regulation, courts, robotics, safety, open models, jobs, energy, quantum, health, education, coding and company results (`profiles.json`, sha256 `a5932290…`). Every article of the pooled stream and anthropic-outlets (4,654) has a label for every profile, so no pooling is necessary. Eight blind annotators did the main pass. A second annotator labelled 400 random articles again: Cohen's kappa is 0.89 to 1.00 for 14 profiles and 0.66 for jobs, and only 1 of 6,400 judgments is relevant against not relevant. The other differences are relevant against ambiguous. The exam (deepmind-outlets) has labels for the 15 new profiles too, sealed by their annotator.

## Round 1 (2026-10-27): no design chosen

Round 1 simulated a reader who teaches a profile with 3 or 10 relevant and 3 or 10 not-relevant articles, in 50 seeded draws. It compared 27 candidates: Rocchio, the nearest taught articles, and a logistic probe, each with or without the profile sentence, and each with no calibration, Platt scaling, or Platt scaling with a prior correction. Its rule was frozen before any score (`round-1/selection-rule.json`, sha256 `672d1084…`).

No candidate passed. On the realistic stream, every candidate scored below the keyword rule `biolog OR scienc` (F0.5 0.106), and no Brier score beat the base-rate predictor (0.0050). The exam was not opened.

## Pooling (2026-10-27): a larger AI-news stream has no more Biology

The Decoder and SiliconANGLE gave 3,838 articles from April to October 2026. Pooling found 7 relevant articles. The random stratum found none in 300 (base rate 0.18%, 95% interval 0.18% to 1.33%). About 25,000 such articles would give 50 relevant ones. One profile alone cannot give the statistical power to compare designs.

## Round 2 (2026-10-28): 16 profiles, no design chosen

The standard answer to low power in filtering research is more topics, not more articles for one topic: for the same labelling work, many topics judged shallowly compare systems more reliably than one topic judged deeply (Sanderson and Zobel 2005; Carterette et al. 2008). TREC-11 used 100 topics. Round 2 uses the 16 profiles above. It teaches from articles before June and tests on June to October. It compares 14 candidates: the profile sentence alone, two Rocchio forms, the nearest taught articles and a logistic probe, each with Platt scaling, Platt scaling with a prior correction, or the binormal calibration. A candidate must beat both keyword rules and both trivial designs on the macro mean F0.5 over the 11 profiles with enough relevant articles, with a profile-level bootstrap interval above 0. Its rule was frozen before any label was read (`round-2/selection-rule.json`, sha256 `d4913ede…`).

No candidate passed. The narrow keyword rule (a stem that a person types first, for example `robot`) scored 0.569. The textbook Rocchio with the sentence as the query scored 0.538 and the sentence alone 0.532, both with the binormal calibration. Their intervals against the keyword rule include 0. The binormal calibration roughly doubled every design's score over Platt scaling, and the sentence alone with it is the only design whose Brier score beats the base-rate predictor (skill +0.111). The designs win on profiles with varied words (security, company results, coding, jobs) and lose on profiles that one stem names (chips, robotics, courts, quantum). Biology had too few relevant articles to count (12), but there Rocchio with the sentence scored 0.507 against the keyword rule's 0.417.

## Round 3 (2026-10-28): a lexical signal, no design chosen

Round 3 added what round 2 lacked: Rocchio over stemmed tf-idf words, with the profile name and sentence as the query, the classic filtering profile (Buckley, Salton and Allan 1994). It fused it with the dense Rocchio by adding the two scores after z-score normalisation (Lee 1997). Same labels, draws and pass rule as round 2 (`round-3/selection-rule.json`, sha256 `f846855f…`). The dense Rocchio gave exactly the round-2 score, so the two runs agree.

No candidate passed. The fused design scored 0.557 against the keyword rule's 0.569 (interval of the difference −0.080 to +0.052), and it beats the broad keyword rule. Its ranking is the best of every design on most profiles (average precision: chips 0.73, courts 0.82, robotics 0.86, company results 0.96). Its threshold fails. Most articles share no stemmed word with a profile, so the scores fall into two groups: articles with no shared word, and articles with one or more. The binormal model takes the second group for the relevant curve, and the profile accepts 300 to 1,000 articles where 50 to 100 are relevant.

## Round 4 (2026-10-28): the reader's keywords as evidence, no design chosen

On 2026-10-28 the maintainer agreed that a profile can hold optional keywords next to its sentence. Round 4 adds the keywords to the probability as evidence, with naive Bayes (Lewis 1998): a matching article gets the odds ratio of a keyword match among relevant and among all articles. It does not use the keywords as a gate, because the post-hoc check in round 3 showed that "keyword or filter" adds the wrong picks of both. To stop the reuse of one labelled set (limitation 12), round 4 tests on a fresh set: 1,675 articles from The Decoder and SiliconANGLE, January to March 2026, labelled by four blind annotators. It teaches from the whole round-2 set. Its rule was frozen before the fresh articles were crawled (`round-4/selection-rule.json`, sha256 `ead2b9f6…`).

No candidate passed, but the result is the closest so far. The sentence alone plus the keywords scored 0.733 against the typed keyword's 0.679, and its Brier skill is +0.475. It beats the broad keyword rule and the trivial designs. Against the narrow keyword, the interval is −0.012 to +0.118, so the rule does not choose it. It wins on 8 of 11 profiles, ties on chips, and loses on robotics (0.833 against 0.860) and regulation (0.117 against 0.303). On regulation, the binormal fit is unstable: in some draws it takes the cluster of government stories for the relevant curve and accepts hundreds of articles. Fitting the binormal model inside each keyword group did not help, because the groups are too small. Biology had 7 relevant fresh articles, too few to count: 0.782 against the keyword's 0.667.

## Round 5 (2026-10-28): replication on a second fresh slice, no design chosen

Round 5 tested the round-4 design again, unchanged, on 1,735 articles from October to December 2025, labelled by four blind annotators (`round-5/selection-rule.json`, sha256 `11faab82…`). It also tested one guard for limitation 13: the stream counts as much as the taught articles in the shape of the two bell curves (Nigam et al. 2000).

No candidate passed. The design scored 0.697 against the typed keyword's 0.644, the same lead as in round 4 (+0.05), and its interval was −0.040 to +0.137. It lost again on robotics, regulation and, by a little, chips. The guard made every profile but regulation worse (0.592): the stream holds the information about the base rate that a few taught articles do not.

## Round 6 (2026-10-28): the reader's way of teaching, no design chosen

Round 6 answers limitation 14. On each fresh slice, the reader shows its top matches from the first 14 days (the top 5 or 10 by the sentence, and the top 5 or 10 keyword matches), the answer key says yes or no, and the profile learns only from those answers (`round-6/selection-rule.json`, sha256 `0d145514…`).

No candidate passed. The sentence plus the keywords scored 0.701 against the typed keyword's 0.656 (interval −0.019 to +0.118), with Brier skill +0.512, the best calibration so far. The lead is the same as in rounds 4 and 5. The lower bound is above −0.05, so the design is not worse than the keyword by more than 0.05 (non-inferiority, reported, not the pass rule).

## Rounds 7 and 8 (2026-10-29): fits that model the selection of taught answers, no design chosen

Round 7 (`round-7/selection-rule.json`, sha256 `c615b539…`) fitted the two bell curves by maximum likelihood with the taught answers as samples above the cut-off of what the reader showed (Zhang and Callan 2001). It was tested three ways: teach from the first 14 days of a slice (window), or from the top of the large labelled pool (two pools). It won both pool tests (0.711 against the keyword's 0.659, and 0.742 against 0.679) and missed the window test: lower bound −0.061 against the −0.05 margin. The frozen design passed the window test and failed both pool tests.

Round 8 (`round-8/selection-rule.json`, sha256 `6249268c…`) made the wrong solution of round 7 impossible to write (relevant mean = other mean + a positive gap) and kept the best of three starts. It failed all three tests. With few answers, the likelihood itself often prefers a broad relevant curve that takes most articles above the cut-off, so the best start chose it.

Rounds 6 to 8 used the same labelled slices, so round 9 tests round 7's design unchanged on July to September 2025, which no round has seen.

## Round 9 (2026-10-29): confirmation on a slice no round had seen, every design failed

Round 9 (`round-9/selection-rule.json`, sha256 `6909823c…`) tested round 7's design unchanged, a variant with a safer fallback, and the frozen design on 1,617 articles from July to September 2025, labelled by four blind annotators. With teaching from the first 14 days, the designs scored 0.48 to 0.58 against the typed keyword's 0.68. With teaching from the large pool, round 7's design tied the keyword (0.632 against 0.633) and the frozen design lost (0.472). The leads of rounds 4 to 7 did not hold on new months.

Post hoc, the main failure moved: with one or two relevant answers in the shown articles (earnings, courts), the fit sets the relevant share to its floor and accepts two or three articles. The ranking is still strong (the fused and pool fits put the right articles on top), but a yes/no threshold from a few selected answers is not reliable. TREC's adaptive filtering work found the same: setting the threshold is the hard part of filtering (Robertson 2002).

## Round 10 (2026-10-29): rank, do not decide

Round 9 showed that the ranking is strong and the yes/no threshold is not. On 2026-10-29 the user chose a ranked reader: each profile shows its best N articles a day, best first, and the person sets N. TREC calls this task routing and scores it by mean average precision (MAP). Round 10 (`round-10/selection-rule.json`, sha256 `37952976…`) compared three rankers with a keyword ranking (matches first, newest first) on July to September 2025.

All three passed in both protocols. The chosen ranker, the frozen design's probability used as the order (desc+kw), scored MAP 0.717 against the keyword's 0.514 with teaching from the first 14 days (interval of the difference +0.082 to +0.296), and 0.766 against 0.476 with teaching from the pool (+0.215 to +0.374). It is frozen with its exam rule in `freeze-ranking/plan.json` (sha256 `c43a44d0…`). The round's daily top-N precision table is not a fair comparison with a keyword list, which shows only that day's matches; per-day recall was not measured. July to September served rounds 9 and 10, so the exam is the confirmation.

## Exam (2026-10-29): the ranker passed

The exam was scored one time, through the package, by the rule frozen in `freeze-ranking/plan.json` before it was opened: deepmind-outlets (133 articles), teaching from the whole labelled pool by the reader's own way of teaching, the 5 profiles with at least 3 relevant exam articles (biology, funding, robotics, safety, open models). MAP: desc+kw 0.867, typed keyword 0.649, broad keyword 0.651, newest first 0.075. Intervals of the difference (paired article bootstrap): against the typed keyword +0.105 to +0.331, against the broad keyword +0.042 to +0.342, against newest first +0.656 to +0.877. All three pass conditions hold. Biology: 0.790 against 0.579. With 5 profiles and 133 articles the intervals are wide; the margin against the broad keyword is the thinnest.

## Limitations

### 1. A realistic stream has few relevant articles

**What happens.** The realistic stream had 4 relevant articles in 816. With so few, no score can tell a good design from a keyword rule.

**Before you change it.** Label a larger stream with pooling, and estimate the misses from the random stratum. A score on fewer than about 20 relevant articles is not a result. Pooling 3,838 articles found only 7 for Biology, so round 2 answered this with many profiles instead.

### 2. Taught articles from another kind of source make the profile worse

**What happens.** The taught relevant articles came from MIT News. The relevant articles of the realistic stream are AI-company posts about biology. They read differently. With taught articles, the realistic relevant articles ranked lower than with the profile sentence alone. The sentence alone, embedded with the query prompt, ranked the 4 relevant articles 1st, 4th, 64th and 95th (average precision 0.397).

**Before you change it.** Use the profile sentence as the main query, and let the taught articles move it. This is the textbook Rocchio form (Buckley, Salton and Allan 1994: the query has its own weight, α 8, β 16, γ 4). Round 1 added the sentence as one more taught article, which gave it too little weight. Prefer taught articles from the reader's own feed.

### 3. A few taught articles cannot calibrate a probability

**What happens.** Platt scaling fitted on 6 to 20 taught scores was too sharp, and its probabilities assumed a base rate of 23% to 77%. On the realistic stream, the profile then accepted 200 to 800 of 803 articles. The prior correction (Saerens, Latinne and Decaestecker 2002) then collapsed to 0 or 1.

**Before you change it.** Calibrate with information from the stream, not only from the taught set. Options to measure: a base rate that the reader states, a bounded prior estimate from the stream, or adaptive filtering from the reader's later yes and no. A base rate that the host gives is an input of the package. Raise it as a package question before you add it. Round 2: the binormal model, fitted on the unlabelled stream, works for dense scores (limitation 10 for its limit).

### 4. Round 1 had two setup errors

**What happens.** The logistic probe used C 1 on unit-length vectors, so it was almost a constant. Its leave-one-out ranking was inverted at 3 not-relevant articles, and Platt scaling then fitted a slope with the wrong sign. The Rocchio form was not the textbook form (limitation 2).

**Before you change it.** State the regularisation scale in the selection rule. Check that the leave-one-out ranking is better than chance before calibration.

### 5. Many science sources refuse Anthropic's crawlers or automated collection

**What happens.** STAT News, phys.org, Science News, the Broad Institute, GEN and New Scientist disallow Anthropic's agents in robots.txt. Quanta Magazine and The Transmitter forbid automated collection in their terms. The research skipped them. Ars Technica also disallows Anthropic's agents. The anthropic-outlets set holds 62 Ars articles from an earlier crawl, which the maintainer chose to keep.

**Before you change it.** Read robots.txt for every agent and for Anthropic's agents, and read the terms, before you add a source.

### 6. Sites give dates in forms the crawler does not read

**What happens.** MIT News, the Arc Institute and Isomorphic Labs give the publish date only in visible markup, and Fortune only in JSON-LD. The crawler returned no date, so each crawl read it from the cached page (elt #3148). A period crawl also cannot stop paging at a date (elt #3212).

### 7. The research data is outside the repository

**What happens.** The labels, crawls and rounds are in a hidden folder on one Mac. The anthropic-outlets texts exist only in the gitignored eval cache of event detection (#3213).

**Before you change it.** Move the labels and the round scripts into the package's eval harness when the package exists, as event detection did (#3145).

### 8. The boundary of "Biology" needs judgement

**What happens.** Biosecurity safeguards, funding calls for life-science research, and bio-company deals were the hardest cases. The rule puts them in the ambiguous list or under not relevant.

**Before you change it.** Keep one written rule per profile, and record each change to it with a reason.

### 9. A typed keyword is a strong baseline

**What happens.** The narrow keyword rules were written by a person who knows the topic (`robot`, `quantum`, `lawsuit|court`). On profiles that one word names, they are close to the answer key, and no design beat them across profiles (rounds 2 and 3). The same words from the profile name and sentence, used automatically, scored far lower (0.230).

**Before you change it.** Keep the typed keyword as a baseline: it is what a reader can do without the package. If a design cannot beat it, a profile could hold keywords from the reader as well as a sentence. That is a product question for the maintainer, not a research default.

### 10. The binormal threshold needs scores shaped like two bell curves

**What happens.** The binormal calibration works for dense scores (round 2) and fails for lexical and fused scores, which are zero for most articles (round 3). The fused design has the best ranking but the worst threshold.

**Before you change it.** Measure a threshold rule that does not assume a score shape, or a score model for scores that are often zero, before you change the fused ranking.

### 11. Some profiles are mostly ambiguous

**What happens.** In the test period, safety has 141 ambiguous articles and 81 relevant; chips 137 and 134. Opinion on AI risk, safety statements without results, chip-company results and compute deals that name chips are the usual cases. Scores leave the ambiguous articles out, so these profiles have fewer test articles than their size suggests.

**Before you change it.** Read the annotators' boundary cases in the round notes before you change a profile's rule.

### 12. Rounds 2 and 3 used the same labelled set

**What happens.** Round 3 was designed after round 2's results on the same labels. Each round that reuses a development set fits it a little more (Dwork et al. 2015).

**Before you change it.** For a round 4, label a fresh month of the same feeds with the same rule, or count the reuse as a known risk. The sealed exam stays the final check. Round 4 did this with January to March 2026.

### 13. The binormal fit can take a wrong cluster

**What happens.** In round 4, the binormal model for regulation sometimes fitted its relevant curve to a large group of government stories, most of them labelled not relevant or ambiguous. The profile then accepted hundreds of articles in that draw.

**Before you change it.** Guard the fit before you change the design: for example, bound the share of relevant articles that the fit may claim, or fall back when the share jumps far above the taught evidence. Pre-register the guard and test it on a fresh slice.

### 14. The rounds teach differently from the product

**What happens.** Rounds 1 to 5 draw the taught articles at random from labelled pools. In the reader (#3205, #3248), a person teaches a profile by answering yes or no on the reader's own best matches for the sentence and keywords. Those articles score high by construction, so the taught relevant and not-relevant articles differ from random draws. This is training-serving skew, and it touches the binormal fit, which the taught scores anchor.

**Before you change it.** Simulate the product's teaching before a design is frozen or the exam is scored: rank the first part of a stream by the sentence and keywords, let the answer key answer yes or no on the top matches, teach from those answers, and score the rest of the stream (the TREC adaptive filtering protocol gives judgments only for delivered articles). Use the same protocol in the exam verdict.

### 15. Taught answers from the top of a large pool break the binormal fit

**What happens.** The package (`packages/information-filtering/relevance-filtering`, commit 9a5ea94) rehearsed the frozen exam protocol on development data before the exam: teach from the top 5 or 10 matches of a 6,300-article pool, decide on October to December 2025. It failed: macro F0.5 0.376 against the typed keyword's 0.524, Brier skill −0.019. The research code gives the same numbers. The top matches of a large pool have the most extreme scores, so the fit puts the relevant curve 3 to 4.4 standard deviations up and the relevant share at its floor; security accepted nothing. Round 6 taught from about 250 articles, so it did not show this. In the reader the pool grows every day, so this is a defect of the design, not of the exam.

**Before you change it.** Do not score the exam with this design. The taught answers are a selected sample: a person judges only what the reader shows. The standard fix models that selection: fit the score distributions by maximum likelihood with the taught scores as samples above the cut-off of what was shown (Zhang and Callan, SIGIR 2001, for adaptive filtering thresholds). Pre-register it and test it under both teaching protocols (a small window and a large pool).

## Rules for every round

- Freeze the selection rule before any score, and the plan before the exam.
- Never open the exam before a design is frozen. Score it one time.
- Choose a design across profiles, with the same parameters for every profile. A design must beat the keyword rules and the trivial designs on the macro mean, with a profile-level bootstrap interval above 0.
- Put the result of the round in this record.
