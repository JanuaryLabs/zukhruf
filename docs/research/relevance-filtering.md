# Relevance filtering: research record

This record keeps what the research for relevance filtering found, before the package exists. The research asks one question: can a cheap program tell if a new article matches a reader's standing interest, and give a probability that the reader can trust? The planned package is `@zukhruf/relevance-filtering`, in `packages/information-filtering/` (backlog #3195). Event detection (`docs/research/event-grouping.md`) is the other half of the reader. Event detection removes duplicates. Relevance filtering keeps what matches the reader's interests.

Read this record before you change the design, add a profile type, or start a new evaluation. Add the result of each new round to this record.

Status on 2026-10-27: round 1 chose no design. A larger realistic stream is in labelling (pooling). The exam set is sealed.

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

## The data

All files are on the maintainer's Mac in `~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-biology/`. The labelling rule (`rule.md`, sha256 `7e6aa431…`) was frozen before the first label.

| Set                                                       | Articles     | Relevant | Ambiguous | Role                                 |
| --------------------------------------------------------- | ------------ | -------- | --------- | ------------------------------------ |
| anthropic-outlets (AI news)                               | 816          | 4        | 11        | Training, realistic base rate (0.5%) |
| training-extra (MIT News, Arc Institute, Isomorphic Labs) | 83           | 42       | 13        | Training, enriched base rate (51%)   |
| deepmind-outlets                                          | 133          | 11       | 8         | Exam, sealed                         |
| pooled (AI news, about 2,000)                             | in labelling |          |           | Training, realistic base rate        |

One annotator (an AI model) labelled every set. No second annotator checked the labels.

## Round 1 (2026-10-27): no design chosen

Round 1 simulated a reader who teaches a profile with 3 or 10 relevant and 3 or 10 not-relevant articles, in 50 seeded draws. It compared 27 candidates: Rocchio, the nearest taught articles, and a logistic probe, each with or without the profile sentence, and each with no calibration, Platt scaling, or Platt scaling with a prior correction. Its rule was frozen before any score (`round-1/selection-rule.json`, sha256 `672d1084…`).

No candidate passed. On the realistic stream, every candidate scored below the keyword rule `biolog OR scienc` (F0.5 0.106), and no Brier score beat the base-rate predictor (0.0050). The exam was not opened.

## Limitations

### 1. A realistic stream has few relevant articles

**What happens.** The realistic stream had 4 relevant articles in 816. With so few, no score can tell a good design from a keyword rule.

**Before you change it.** Label a larger stream with pooling, and estimate the misses from the random stratum. A score on fewer than about 20 relevant articles is not a result.

### 2. Taught articles from another kind of source make the profile worse

**What happens.** The taught relevant articles came from MIT News. The relevant articles of the realistic stream are AI-company posts about biology. They read differently. With taught articles, the realistic relevant articles ranked lower than with the profile sentence alone. The sentence alone, embedded with the query prompt, ranked the 4 relevant articles 1st, 4th, 64th and 95th (average precision 0.397).

**Before you change it.** Use the profile sentence as the main query, and let the taught articles move it. This is the textbook Rocchio form (Buckley, Salton and Allan 1994: the query has its own weight, α 8, β 16, γ 4). Round 1 added the sentence as one more taught article, which gave it too little weight. Prefer taught articles from the reader's own feed.

### 3. A few taught articles cannot calibrate a probability

**What happens.** Platt scaling fitted on 6 to 20 taught scores was too sharp, and its probabilities assumed a base rate of 23% to 77%. On the realistic stream, the profile then accepted 200 to 800 of 803 articles. The prior correction (Saerens, Latinne and Decaestecker 2002) then collapsed to 0 or 1.

**Before you change it.** Calibrate with information from the stream, not only from the taught set. Options to measure: a base rate that the reader states, a bounded prior estimate from the stream, or adaptive filtering from the reader's later yes and no. A base rate that the host gives is an input of the package. Raise it as a package question before you add it.

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

## Rules for every round

- Freeze the selection rule before any score, and the plan before the exam.
- Never open the exam before a design is frozen. Score it one time.
- Report the realistic stream and the enriched stream apart. A design must beat the keyword rules and the trivial designs on the realistic stream.
- Put the result of the round in this record.
