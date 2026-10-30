# Event detection: research record

This record keeps what the research for event detection found, before a package exists. The research asks one question: can a cheap program put news articles that report one event into one group? The packages are `@zukhruf/embeddings` (`Collection`) and `@zukhruf/event-detection` (`EventDetector`). The limitations of event detection (13, 14, 18 to 22) are also in [packages/information-filtering/event-detection/docs/limitations.md](../../packages/information-filtering/event-detection/docs/limitations.md), and that copy is the current one. This record keeps the history.

Read this record before you change the design, add a feature, or start a new evaluation. Each limitation tells you what happens, what proves it, why it happens, and what to think about before you fix it.

## Why this research started

On 2026-10-23 the maintainer started to design a news reader engine, in the way of brutalist.report: it reads many feeds and shows a short list of what is new. The engine has three stages in this order: ingestion, then near-duplicate detection, then content filtering. The elt library does the ingestion (source-web-pages). Event detection is the second stage. Many outlets report one launch, one lawsuit or one storm. Without event detection, the reader sees the same story eight times. With it, the reader sees one event and its sources. A false join is worse than a duplicate, because it hides news (the 2020 Equifax indictment under the 2017 breach). That is why the research chose F0.5. The engine is the first consumer. The packages do not know it, so another consumer can use them too.

## Status

Status on 2026-10-26: round #3124 failed its gate. Round #3130 passed its gate for full articles. It fails on articles that have only a headline. Backlog #3131 built the packages from the #3130 design. Status on 2026-10-28: round #3232 compared Qwen3-Embedding-0.6B with EmbeddingGemma 2, and design 3152b stays. Status on 2026-10-29: round #3142 chose a clean body with the template segments of each publisher removed; its exam was inconclusive, so design 3152b stays, and no unscored exam set is left. Status on 2026-10-27: round #3152 added a same-publisher term and fitted the weights again on four training sets. The package now holds the #3152 design, and it gives the scores of the round on the six sets that are not the exam set. The exam set (deepmind-outlets) is not scored yet. Add the result of each new round to this record.

## Words in this record

| Word          | Meaning                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Event         | One real occurrence at one time and place. Two lawsuits by one company are two events.                                                |
| Topic         | What a text is about. Many events can have one topic.                                                                                 |
| Pair          | Two articles that the program compares.                                                                                               |
| Pair score    | The probability, from 0 to 1, that the two articles of a pair report one event.                                                       |
| Shortlist     | The nearest articles of an article, by embedding similarity. Only these articles become pairs. The standard term is blocking.         |
| Grouping step | The step that turns pair scores into groups of articles.                                                                              |
| False join    | Two articles of different events in one group. A false join can hide news.                                                            |
| False split   | Two articles of one event in different groups. A false split shows a duplicate.                                                       |
| Precision     | The share of joined pairs that are correct.                                                                                           |
| Recall        | The share of real same-event pairs that the program joins.                                                                            |
| F0.5          | A score that counts precision two times as much as recall. The user chose it on 2026-10-26: a false join is worse than a false split. |
| B-cubed       | A clustering score. For each article, it compares the article's group with the article's real event.                                  |
| Arrival order | The order in which the program receives the articles.                                                                                 |
| Lead          | The title and the first two real sentences of an article.                                                                             |
| Dataset shift | A model learns from one kind of input and then gets a different kind.                                                                 |

## The rounds

All evidence is on the local Mac in `~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/`. The backlog items hold the full reports.

| Round        | Question                                                                                    | Result                                                                                                                 | Folder                     |
| ------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| #2938        | Do embeddings find topics and events on new articles?                                       | Topics: yes. Events: no.                                                                                               | `embedding-heldout-2938`   |
| #2944        | Can a reranker or a classifier decide the event?                                            | No tested method was ready.                                                                                            | `event-grouping-2944`      |
| #2947, #2948 | Do event summaries made by a local LLM help? How many neighbours must the shortlist keep?   | Summaries lose evidence. 80 neighbours keep 99% of real pairs.                                                         | `event-evidence-2947-2948` |
| #2957        | Can a local LLM compare two full articles?                                                  | Good results, but too slow. The user closed this route.                                                                | `event-evidence-2957`      |
| #3124        | Can cheap features with a logistic regression decide the event?                             | Failed its gate on ECB+.                                                                                               | `feature-scorer-3124`      |
| #3130        | Same question, with full-article training data and a new grouping step.                     | Passed on the Gun Violence Corpus. Fails on headline-only input.                                                       | `feature-scorer-3130`      |
| #3152        | Which fix lowers the false joins on one company's news and its outlets (limitation 23)?     | Weights fitted again + a same-publisher term, threshold 0.45 (3152b). Passed the exam: CoNLL F0.5 0.883 against 0.818. | `feature-scorer-3152`      |
| #3232        | Is Qwen3-Embedding-0.6B better than EmbeddingGemma 2 when each gets its own weights?        | No. The gain interval includes 0, so design 3152b stays. The exam nvidia-outlets stays unscored.                       | `eval/rounds/3232` (repo)  |
| #3142        | Does a clean body without the template segments of each publisher stop one-publisher joins? | Chosen on training (+0.029 over a refit). Exam nvidia-outlets inconclusive (+0.003 [−0.010, +0.017]), 3152b stays.     | `eval/rounds/3142` (repo)  |

## The design that passed (#3130)

The packages start from this design. Change it only with a new round.

| Part                   | Choice                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text for the embedding | Title and lead. A general rule removes URL and boilerplate segments.                                                                                                                  |
| Shortlist              | 80 nearest neighbours by raw cosine, published within 7 days.                                                                                                                         |
| Pair score             | Logistic regression on raw cosine and two number features over the full body: numbers that agree, and numbers that disagree.                                                          |
| Grouping step          | On each new publish day, group-average clustering of the 7-day window again. Event IDs move forward by the largest overlap. Between those runs, a new article joins by group average. |
| Cut-off                | 0.5.                                                                                                                                                                                  |
| Selection              | Cross-validation on ECB+ (5 topic folds) and on #2938 with #2957 (one fold). The score was B-cubed F0.5.                                                                              |

Result on the Gun Violence Corpus, which no earlier round had seen (509 documents, 241 incidents). The baseline is centered title embeddings with complete linkage at 0.6.

| Score                                     | Design                                       | Baseline              |
| ----------------------------------------- | -------------------------------------------- | --------------------- |
| Pair precision / recall / F0.5            | 0.918 / 0.712 / 0.868                        | 0.820 / 0.144 / 0.423 |
| B-cubed precision / recall / F0.5         | 0.977 / 0.849 / 0.948                        | 0.978 / 0.554 / 0.848 |
| B-cubed F0.5 range over 10 arrival orders | 0                                            | not measured          |
| Cost for each article                     | About 15 ms, of which 13 ms is the embedding | —                     |

## The design of round #3152

Round #3152 kept the #3130 design and changed only the pair score (package ADR 0005). It fitted the weights again on the pairs of anthropic-outlets, ECB+, #2938 and #2957, and it added a term for two reports of the same publisher. The weight of that term is negative. The round froze its selection rule before it scored a candidate, and its `plan.json` (sha256 `78a56767…`) before it scored the exam set.

A design that leaves every report alone then beat design 3130 on B-cubed F0.5 on three sets, so the evaluation moved to the scores of coreference research, with CoNLL F0.5 as the objective (eval/README.md). A second selection (3152b) ran with that objective, with nested cross-validation, on the training sets only. It chose the same pair score and the same weights, with the threshold 0.45 instead of 0.5 (`plan.json` sha256 `dc26dbd8…`). The table below is from the first selection; package ADR 0005 has the table of the second.

| Candidate                                                    | Training objective | gvc pair / B-cubed F0.5 | Eligible |
| ------------------------------------------------------------ | ------------------ | ----------------------- | -------- |
| #3130 as it is                                               | 0.892              | 0.868 / 0.948           | yes      |
| Weights fitted again                                         | 0.916              | 0.892 / 0.953           | yes      |
| Weights + same publisher (chosen, the cheapest of five tied) | 0.932              | 0.898 / 0.957           | yes      |
| Weights + clean lead + numbers without URLs + same publisher | 0.936              | 0.911 / 0.960           | yes      |
| Weights + a limit of 1 day for one event                     | 0.937              | 0.811 / 0.926           | no       |
| Weights + named entities                                     | 0.921              | 0.871 / 0.945           | no       |

The objective is the mean B-cubed F0.5 of three families of cross-validation folds. A candidate is eligible when gvc and hlgd-test are not lower than #3130. Candidates within 0.005 of the best eligible objective are tied, and the cheapest wins. On anthropic-outlets, cross-validation B-cubed F0.5 went from 0.820 to 0.918, and the pair precision of pairs of one publisher from 0.166 to 0.447. Over five shuffles of the reports of each publish day, B-cubed F0.5 stayed from 0.9186 to 0.9193 on anthropic-outlets and at 0.9572 on gvc. The exam passes if the exam B-cubed F0.5 and pair F0.5 are higher than #3130, and gvc and hlgd-test are not lower.

## Round #3232: a second embedding model

On 2026-10-28 the maintainer chose one second embedding model to compare with EmbeddingGemma 2: Qwen3-Embedding-0.6B (Q8_0 GGUF, 639 MB, last-token pooling). Its MTEB English v2 score is 70.70, against 68.46 for EmbeddingGemma 2. The larger Qwen3 sizes were not tried, because the model runs on the user's Mac at sync time. This was the first round that ran in the repository, with `nx run event-detection:fit -- 3232`, and not in a research folder.

The rule (`packages/information-filtering/event-detection/eval/rounds/3232/selection-rule.json`) was committed before any Qwen score. It keeps the folds, the features, the lead rule, the shortlist, the window, the threshold grid, the nested cross-validation of the CoNLL F0.5 and the eligibility rules of round 3152b. Each candidate got its own fitted weights and threshold. G is the recipe of design 3152b, fitted again under the same rule. Its nested score is the cross-validated score of design 3152b, because the final weights of 3152b saw every fold.

| Candidate                          | Vector text                                                                        | Nested CoNLL F0.5 | anthropic-outlets / ECB+ / small | Final threshold | gvc change against 3152b | Eligible  |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------- | -------------------------------- | --------------- | ------------------------ | --------- |
| G (EmbeddingGemma 2, design 3152b) | `title: {title} \| text: {title}\n{lead}`                                          | 0.822             | 0.797 / 0.763 / 0.905            | 0.45            | 0                        | incumbent |
| Q-plain (Qwen3-Embedding-0.6B)     | `{title}\n{lead}`                                                                  | 0.820             | 0.810 / 0.761 / 0.889            | 0.55            | -0.006 [-0.027, +0.016]  | yes       |
| Q-instruct (Qwen3-Embedding-0.6B)  | `Instruct: Identify the news event that this report covers\nQuery:{title}\n{lead}` | 0.818             | 0.809 / 0.752 / 0.892            | 0.50            | -0.036 [-0.055, -0.017]  | no (E3)   |

- Q-plain was the challenger. Its change against G on the cross-validated objective was -0.002, with the 95% bootstrap interval [-0.016, +0.011] over 831 blocks. The interval includes 0, so the rule kept design 3152b.
- Qwen joined more real pairs on anthropic-outlets (+0.012), and lost on the small family and on gvc.
- Cost (`eval/rounds/3232/cost.json`): one lead took 20.8 ms (median) and 25.6 ms (p90) with Qwen, against 16.8 ms and 18.8 ms with EmbeddingGemma 2. The Qwen server used 1,004 MB (phys_footprint) against 133 MB, at a context of 8,192 tokens.
- The exam set nvidia-outlets was not scored, because no Qwen design was chosen. It stays the exam of the next round.

## Round #3142: the template segments of one publisher

On 2026-10-29 the reader app 'What is going on' ran design 3152b on the feeds and blogs of 41 AI labs and outlets. One publisher's different posts joined one event: 19 ElevenLabs posts, 5 Together AI benchmark posts, 4 xAI "Grok 4.6 on <platform>" posts. The diagnosis (pair-score terms of the live events) found the cause in the lead and the numbers. The sentence split cut the ElevenLabs banner URL at its "?", the rest of the URL and the site promotion were the lead of every post, and URL fragments gave about 15 agreeing numbers to each pair. The same-publisher term took away 2.1 from the logit; the similarity added 5.3.

The round labelled the live reports as the training set labs-outlets (745 reports, 677 events, two blind annotators, CoNLL F1 agreement 0.995 on 253 reports). It froze its rule (`eval/rounds/3142/selection-rule.json`, sha256 `673d03a8f12944cc571cb99a361929c6c90acc983ea8d6c948c2c3abc82dc950`) before any score, and ran in the repository with `nx run event-detection:fit -- 3142` (plan.json sha256 `aaaa1fce…`).

| Candidate                                                   | Nested CoNLL F0.5 | Threshold |
| ----------------------------------------------------------- | ----------------- | --------- |
| R: design 3152b fitted again, with labs-outlets (incumbent) | 0.798             | 0.35      |
| U: clean body (URLs before the split, numbers without URLs) | 0.813             | 0.50      |
| T: U and the template segments of each publisher (chosen)   | 0.827             | 0.45      |
| TI: T and a same-publisher similarity term                  | 0.825             | 0.50      |

- A segment is a template when two reports of one publisher hold it. This is site-level template detection (Bar-Yossef and Rajagopalan, WWW 2002; Vieira et al., CIKM 2006). jusText and Boilerpipe classify the blocks of one page; they do not see what a site repeats.
- T beat R by +0.029 [+0.004, +0.043] (1,469 blocks). On labs-outlets it gave 0.813 against 0.727 for design 3152b as it is. The regression intervals against 3152b: gvc +0.006 [0.000, +0.015], hlgd-test −0.001 [−0.004, 0.000], deepmind-outlets −0.013 [−0.067, +0.029].
- The exam nvidia-outlets (687 reports) was scored one time: CoNLL F0.5 0.777 against 0.774 for 3152b, +0.003 [−0.010, +0.017] (426 blocks). Inconclusive: design 3152b stays. nvidia-outlets is a regression set now, so the next round needs a new exam set.
- Live cases, in sample on labs-outlets: the ElevenLabs posts split (one pair still joins), the Grok posts become two pairs, the true cross-publisher events stay. The 5 DeepSWE posts and the Nemotron fine-tuning post still join: their leads and numbers really are alike.
- The package keeps `lead.clean` and the same-publisher similarity term as options of a design, so `fit -- 3142` builds T again. Design 3152b uses neither.
- Two harness bugs were fixed on the way: the fit refused a scored exam set as a regression set, and `eval --exam` stopped at the first scored exam set before it reached an unscored one.

## Limitations

### 1. Embedding similarity measures the topic, not the event

**What happens.** Two articles about one company get a high similarity, also when they report two different events. Examples: two different Python Summit talks, two Claude versions, a Starlink restriction and its later restoration.

**Evidence.** On the #2938 held-out set, centered embeddings joined 1 of 14 real same-event pairs and made 11 false joins.

**Cause.** An embedding encodes each article alone. It cannot compare the details of two articles, such as the date, the place or the version.

**Before you change it.** Do not expect a better embedding model to fix this alone. Add signals that compare details: the date gap, the numbers and the names. Keep embeddings for the shortlist and for topic filtering.

### 2. Raw cosine similarity is high for every pair

**What happens.** Most pairs of news headlines have a cosine similarity near 0.78. There is no gap between related and unrelated pairs.

**Evidence.** An early probe on 1,867 headlines (2026-10-23) found a median of 0.78. After the program subtracted the mean vector (centering), average linkage at 0.60 gave real story groups.

**Cause.** Embedding vectors occupy a narrow cone of the space. The standard term is anisotropy.

**Before you change it.** Keep centering, or another normalization. Calculate the mean vector on training data and freeze it. A mean vector from the test data leaks test information.

### 3. One vector for a long article loses the details

**What happens.** EmbeddingGemma 2 makes one vector as the mean of all token vectors (`pooling_type 1` in its GGUF file). For a long article, the event details become a small part of that mean.

**Evidence.** The 49 full articles of #2938 have a median length of 7,615 characters. 22 of them are longer than about 2,000 tokens. The GGUF file accepts 262,144 tokens, but the research cut chunks at 2,048 tokens. The research did not record the reason for that cut.

**Cause.** Mean pooling. News puts the important facts first (the inverted pyramid), so the lead holds most of the event.

**Before you change it.** The design uses one vector per article, from the lead (Dai and Callan, SIGIR 2019, call this FirstP). The #2948 shortlist kept 607 of 613 real pairs with title and lead vectors. Add one vector per chunk (MaxP) only when a consumer needs facts deep in an article, for example the topic filter. Find the model's tested context length before you embed long text.

### 4. A pair score from one kind of text does not transfer to another kind

**What happens.** The #3124 scorer rejected most real ECB+ pairs. It found 11% of them.

**Evidence.** On ECB+, the scorer gave real same-event pairs a median probability of 0.057, and same-topic pairs of different events 0.001. The order was correct (about 50 to 1), but the cut-off was 0.20. 87% of the missed ECB+ pairs had a pair score under the cut-off. Similarity medians of real pairs: HLGD headlines 0.895, ECB+ leads 0.854, #2938 full-article leads 0.728.

**Cause.** Dataset shift. 83% of the training pairs were HLGD headlines. The scorer then got article leads, which have lower similarity.

**Before you change it.** Train on the same kind of text that the scorer will get. Consider a similarity that is relative to each article's neighbours: the ratio margin (Artetxe and Schwenk, ACL 2019) or CSLS (Conneau et al., ICLR 2018). Then one cut-off can work for different sources. Check the probability scale on each new source before you trust a fixed cut-off.

**Status after #3130.** Training on full-article leads fixed this for full articles. The ratio margin and CSLS lost in cross-validation (B-cubed F0.5 0.72 to 0.88, against 0.92 for raw cosine). They are not proven wrong. The cross-validation streams were small, so each article had few earlier neighbours. Test them again on a large stream. Limitation 18 is the same shift in the other direction.

### 5. Some features help and some features hurt

**What happens.** The features do not have equal value, and the training data of #3124 chose the wrong ones.

**Evidence.** These are the #3124 test ablations. Nothing was tuned on them.

| Feature                                     | Finding                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Publish-date gap                            | The strongest feature when dates exist. HLGD F1 fell from 0.408 to 0.295 without it.     |
| 7-day shortlist window                      | No effect on quality. It reduces cost.                                                   |
| Rare-word overlap (BM25 cosine of the body) | It hurt. F1 went up on all three test sets without it.                                   |
| Numbers and versions                        | It helped. The run without numbers was the worst on ECB+ and Multi-News.                 |
| Named entities (`Xenova/bert-base-NER`)     | Best on ECB+ (F1 0.584). HLGD precision fell to 0.635. It costs 5 to 110 ms per article. |
| Centering                                   | Better than raw cosine on ECB+ and Multi-News.                                           |

**Cause.** The #2938 training set had only 14 positive pairs. One join changed its score from 0.009 to 0.278. That noise picked the features.

**Before you change it.** Get training data with many positive pairs of the target kind. Compare features with cross-validation by topic, so that hard negatives stay in one fold. A feature with agreement and disagreement evidence (the Fellegi and Sunter model) is stronger than overlap alone: "Claude 4.5" and "Claude 5" agree on the name and disagree on the version.

### 6. The shortlist misses some real pairs

**What happens.** The grouping step cannot join two articles that never become a pair.

**Evidence.** Shortlist recall with 80 neighbours: ECB+ 99.7%, HLGD test 97.6%, Multi-News 82.2%. On HLGD, 10 neighbours kept 440 of 590 real pairs, and 80 neighbours kept 584. With complete linkage, 6 missing pairs caused 50 missed pairs in the final groups.

**Cause.** Each article keeps a fixed number of neighbours. Large events have more members than the shortlist can hold. Complete linkage needs a pair between every two members of a group.

**Before you change it.** Measure shortlist recall on a corpus that grows, not only on a fixed set (#2958). Lexical and hybrid shortlists were measured in #2948. Dense neighbours found more real pairs than BM25 neighbours.

### 7. The groups depend on the arrival order

**What happens.** The same articles in a different order give different groups.

**Evidence.**

- #3124, online complete linkage: 137 to 481 pair decisions changed for each order seed. An event that split early never merged again.
- #2957, batch complete linkage with yes/no pair decisions: 6 of 11 orders changed the groups of the full-article method.

**Cause.**

- Online grouping decides when an article arrives, and it cannot change that decision later.
- In batch grouping, yes/no decisions make many pairs equal. `getSmallestDistance` in ml-hclust's `agnes` uses a strict `<`, so the first equal pair in row order wins. Complete linkage then removes the third article of an open triangle (A–B joined, B–C joined, A–C not joined).

**Before you change it.** Prefer pair scores with many values to yes/no decisions. Think about a merge step that can join two events later. Think about a comparison with the whole event (group average or centroid) instead of every member. Yang, Pierce and Carbonell (SIGIR 1998) compare batch group-average clustering with single-pass incremental clustering. Measure order stability for every candidate (#2959).

**Status after #3130.** The cross-validation compared four grouping steps. Online complete linkage scored 0.864 with a range of 0.031 across orders. Online group average scored 0.913 (range 0.022). Group average with a periodic merge scored 0.912 (range 0.019). Group-average clustering of the 7-day window again on each publish day scored 0.923 with a range of 0. The design uses the last one. Inside the window, a new day can still move articles between events. Limitation 8 applies to that window.

### 8. Batch grouping changes old groups when new articles arrive

**What happens.** New articles can move articles that were already in groups.

**Evidence.** In #2944, the historical HLGD groups went from 165 correct joins and 49 false joins to 171 and 60 when unrelated live articles were added.

**Cause.** A batch method calculates all groups again from all articles. Centering on the full set also moves when the set changes.

**Before you change it.** A reader needs stable event IDs. If you group again in batches, carry event IDs forward by the largest overlap, and freeze the centering mean.

### 9. Single linkage makes one large chain

**What happens.** Single linkage joined 1,865 of 1,867 headlines into one group in the early probe.

**Cause.** Single linkage joins two groups when one pair is near. A chain of near pairs connects unrelated articles.

**Before you change it.** Do not use single linkage for events. Complete linkage and group average do not chain like this.

### 10. Rerankers and classifiers trade precision for recall

**What happens.** The tested cross-encoders did not separate events.

**Evidence.** In #2944:

- A Quora duplicate-question cross-encoder found 0 of 14 real pairs, but its known positive check passed.
- Qwen3-Reranker-0.6B raised HLGD recall from 28.0% to 39.7%, but precision fell from 77.1% to 54.7%. It still joined different Claude models and different Python release candidates.
- The NLI models and a 1.2B local generative model did not qualify for the fresh tests.

**Cause.** These models learned relevance or paraphrase, not event identity.

**Before you change it.** Test a model that learned event coreference, not search relevance. Check its cost per pair against the millisecond budget.

### 11. A local LLM judge is accurate but too slow

**What happens.** The user closed this route on 2026-10-26.

**Evidence.**

- In #2957, Qwen3.5-9B compared two full articles in both directions. On the fresh set it found 33 of 36 real pairs with 1 false join.
- It took about 5.9 s of request time for each pair direction.
- 5 pairs got different answers in the two directions.
- It mixed up the start of the Equifax breach (mid-May) with its discovery (29 July) (#2963).

**Cause.** A generative model reads two articles in order, so order changes the answer. Its cost grows with the number of pairs.

**Before you change it.** Use an LLM only for a small set of uncertain pairs, if ever. Compare its cost with the feature scorer: about 25 ms for each article.

### 12. Summaries made before the comparison lose evidence

**What happens.** The program asked a local LLM for an event summary (a frame) of each article, then compared the frames. Most real pairs lost their evidence.

**Evidence.** In #2947, the saved set accepted 188 of 292 frames and supported only 9 of 23 positive pairs. The live set supported 1 of 8. One frame reversed who reported what. Frames dropped a shared DOI.

**Cause.** A frame keeps only what the model chose to write. A correct quote does not prove each generated field.

**Before you change it.** Compare the source text, or features taken directly from it. Do not compare generated summaries.

### 13. The boundary of an event has no written rule

**What happens.** Some errors are disputes about the event boundary, not scorer errors.

**Evidence.** In #2957, a Huawei lawsuit filing and a later motion in the same case were labeled two events. Every method joined them. Two reports of one tornado outbreak, one with a death and one with "no deaths yet", were labeled one event.

**Cause.** "One event" can mean one action or one case. Data sets choose differently.

**Before you change it.** Write the boundary rule for the product before you label data: action level or case level, and how to treat updates. Use the same rule in every label set.

### 14. The input text can be incomplete or noisy

**What happens.** A short or noisy text gives a wrong lead and wrong features.

**Evidence.**

- Web extraction returned only a 97-character description for one page, and a paywall preview for another (#2952).
- The ECB+ rebuild turned the source URL into the first line of 466 of 982 articles.
- `Intl.Segmenter` returns blank lines, image captions and URL parts as sentences (#2957).

**Cause.** The extractor cannot always see whether a page is complete. A sentence splitter does not know what is boilerplate.

**Before you change it.** Remove URL and boilerplate segments from the lead with a general rule. Make extraction report an incomplete page (#2952). Do not use a list of publishers.

**Status after #3130.** A general detokenizer joins URL tokens again, and the lead rule removes URL segments. 0 of 982 ECB+ leads contain a URL now. Partial web pages (#2952) are still open. A partial page is close to headline-only input (limitation 18).

### 15. The test data has limits

**What happens.** Each data set measures only a part of the problem.

| Data set                        | Limit                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| HLGD                            | Headlines only. 195 of 286 test URLs failed when the research fetched the bodies. It may be in the pretraining data of the models. |
| ECB+                            | No reliable publish dates, so the date gap cannot be tested.                                                                       |
| Multi-News                      | Groups of articles cited by one summary. This is story level, not event level. No dates.                                           |
| WCEP (`allenai/wcep_dense_max`) | The group members come from a search, not from people (#2961).                                                                     |
| Miranda et al. (EMNLP 2018)     | The dataset FTP refused every anonymous login on 2026-10-26.                                                                       |
| #2938 and #2957 fresh sets      | Labeled by one Codex session, not by several people. Small.                                                                        |
| Gun Violence Corpus             | Has dates and many similar shootings. The research takes one incident per document from its mention labels.                        |

**Before you change it.** A set that a round has inspected can only be a regression set after that round. Each new design needs a new untouched test set.

### 16. Topic-filter probabilities need calibration

**What happens.** The topic probe ranked well, but its raw probabilities were too high.

**Evidence.** On a held-out day, the 0.5 to 0.7 probability bin was 19 of 19 relevant. After Platt scaling on day-one labels, the bins matched the real rates. On #2938, a soft vote of probes found 26 of 35 relevant headlines with 3 false accepts. Log loss went from 0.363 to 0.245.

**Cause.** The training examples had about 40% positives. Real feeds have far fewer (prior shift).

**Before you change it.** Calibrate the probabilities on data with the real positive rate. Check them again for each new source.

### 17. A result is only useful if a person can run it again

**What happens.** A retained run failed to start later.

**Evidence.** The saved llama.cpp runtime linked its libraries to `/private/tmp`, and macOS removed that folder. Two runs of #2957 failed before the links were repaired (`event-evidence-2957/results/runtime-link-repair.json`). A closed laptop lid caused 60 timeouts in #2957.

**Before you change it.** Keep every runtime file inside the evaluation folder, with relative links. Record hashes of models and packages. Run long stages on power, with the lid open.

### 18. The design joins too much when an article has only a headline

**What happens.** With headlines only, the #3130 design puts almost everything into a few large events.

**Evidence.** On HLGD test, B-cubed F0.5 was 0.284 against 0.819 for the baseline. Pair F0.5 was 0.100 against 0.572, with 6,326 false joins (#3132).

**Cause.** Dataset shift in the other direction (limitation 4). The design learned the cosine scale of title-and-lead text. Two headlines get higher cosine values, so too many pairs pass the cut-off. A headline also has few numbers, so the number features give no disagreement evidence.

**Before you change it.** Give the package a guard for input without a lead. Choose between: no joins for that article, a second model trained on headlines, or a refusal. A paywall preview or a description-only page (#2952) is the same case in production.

### 19. Late follow-up reports start a new event

**What happens.** A report that comes more than 7 days after the event does not join it.

**Evidence.** On the Gun Violence Corpus, 63 of the 100 false splits were more than 7 days apart. One example: an arrest reported 93 days after the shooting (#3133).

**Cause.** The shortlist and the grouping window keep only 7 days. Only #2938 had dates in the training data, so no date feature was trained.

**Before you change it.** Get training data with dates and late follow-ups. Then learn how the date gap changes the pair score, instead of a hard 7-day limit. A longer window costs more in each re-clustering run (limitation 21).

### 20. Look-alike events close in time still join

**What happens.** Different incidents of one kind, a few days apart, can join.

**Evidence.** Most of the 22 false joins on the Gun Violence Corpus were shootings of teenagers 6 to 7 days apart. 127 of the 510 documents mention more than one incident. The research gave each document the incident with the most labeled mentions.

**Cause.** The pair score has no place or person feature. NER added only 0.003 in cross-validation, under the 0.005 margin, so the design does not use it.

**Before you change it.** Test place and person agreement again on data with many look-alike events. Write the rule for a document that reports several incidents (limitation 13).

### 21. The cost of re-clustering at production size is not measured

**What happens.** Each publish day clusters the whole 7-day window again. The cost grows with the square of the window size.

**Evidence.** The daily windows of the Gun Violence Corpus are small. #3130 measured 0.68 ms for each article for the grouping step, at that size only.

**Before you change it.** Measure one re-clustering run at the window size of the real feeds before you choose the window (#3131).

### 22. Small leaks in the cross-validation

**What happens.** The research calculated the centering mean from all fitting folds, so each fold saw a little of its own test data.

**Cause.** One mean for all folds was simpler.

**Before you change it.** Calculate the mean inside each fold. This leak affects only centered cosine, and centered cosine lost. The design uses raw cosine.

## Rules for every new round

- Freeze the features, weights, cut-off and grouping method in `plan.json`, with hashes, before any test scoring.
- Do not tune on a test set. After a round inspects a set, it is a regression set.
- Write the pass rule before the test.
- Report precision, recall and B-cubed scores, the errors with their article text, the cost per article, and the order stability.
- Put the result of the round in this record.
