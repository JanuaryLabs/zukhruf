# Research round #3152 adds a same-publisher term and fits the weights again

On the real mix of its first consumer, the design of round #3130 made many false joins ([limitation 23](../limitations.md)). Most of the false pairs were two reports of one publisher. Round #3152 measured fixes for this on labelled sets with cross-validation, and froze one design before it scored its exam set. This record tells what changed, what the evidence is, and what the round did not choose.

The round froze its design in `plan.json`, sha256 `78a56767d6d454e1053d28bbcd71b8dcf465a69cc948a13275f74a3a4e464154`, at 2026-10-27T11:42:12Z. Its files are in `~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/feature-scorer-3152` on the maintainer's Mac. The rules of [ADR 0001](./0001-the-parameters-are-frozen-by-research-round-3130.md) stay: change a parameter only with a new research round.

## What changed

- A report can have a `publisher`, for example the host of its site. The detector keeps it in the `publisher` column of `event_report`.
- The pair score has a fourth term: same publisher. Its value is 1 when the two reports have the same publisher. It is 0 when they have different publishers, or when one of them has no publisher. Thus a report without a publisher is never of the same publisher as another report, and the detector gives it the same pair scores as when every report has its own publisher.
- The weight of the same-publisher term is negative. At the same similarity, two reports of one publisher report one event less often than two reports of two publishers.
- The round fitted all the weights again, on the pairs of all training sets.

These parts did not change: the lead rule, the vector text, EmbeddingGemma 2, the shortlist of 80 reports, the window of 7 days and the clustering. The second selection (3152b, below) changed the threshold from 0.5 to 0.45.

`src/frozen-design.ts` holds the new values (`plan.json` `design.model`):

| Term                | Weight  | Mean    | Standard deviation |
| ------------------- | ------- | ------- | ------------------ |
| Intercept           | -5.5774 |         |                    |
| Similarity          | 2.4632  | 0.66979 | 0.07681            |
| Agreeing numbers    | 1.2185  | 0.70805 | 0.71465            |
| Disagreeing numbers | -0.8988 | 1.68717 | 0.80937            |
| Same publisher      | -0.6864 | 0.12460 | 0.33027            |

## Evidence

The round wrote its selection rule before it scored a candidate (`selection-rule.json`, sha256 `6f4b073a…`, 2026-10-27T11:31:20Z):

- **Training sets:** anthropic-outlets in 4 folds of whole events in time order, ECB+ in 5 topic folds, and dev2938 with fresh2957 as 1 fold. Each fold got weights fitted on the other 9 folds.
- **Objective:** the mean of the B-cubed F0.5 of the 3 families of folds.
- **Regression sets:** a candidate is eligible only if its pair F0.5 and its B-cubed F0.5 on gvc and hlgd-test are not lower than design 3130.
- **Choice:** the candidates within 0.005 of the best eligible objective are tied. The simplest tied candidate wins, by a written order of cost.

After the first pass, the round made the threshold grid (0.20 to 0.95) and the span grid (1 to 14 days) wider for all candidates, because two candidates chose the edge of a grid.

| Candidate                                                    | Objective | anthropic-outlets B-cubed F0.5 | anthropic-outlets pair P / R | gvc pair / B-cubed F0.5 | Eligible |
| ------------------------------------------------------------ | --------- | ------------------------------ | ---------------------------- | ----------------------- | -------- |
| 3130 as it is                                                | 0.892     | 0.820                          | 0.318 / 0.313                | 0.868 / 0.948           | yes      |
| Weights fitted again                                         | 0.916     | 0.898                          | 0.494 / 0.237                | 0.892 / 0.953           | yes      |
| Weights + same publisher (**chosen**)                        | 0.932     | 0.918                          | 0.630 / 0.245                | 0.898 / 0.957           | yes      |
| Weights + same publisher + publisher mean                    | 0.933     | 0.928                          | 0.701 / 0.241                | 0.894 / 0.956           | yes      |
| Weights + clean lead + numbers without URLs + same publisher | 0.936     | 0.929                          | 0.689 / 0.358                | 0.911 / 0.960           | yes      |
| Weights + span limit of 1 day                                | 0.937     | 0.949                          | 0.871 / 0.210                | 0.811 / 0.926           | no       |
| Weights + named entities                                     | 0.921     | 0.922                          | 0.634 / 0.216                | 0.871 / 0.945           | no       |
| Weights + relative similarity (CSLS)                         | 0.744     | 0.941                          | 0.771 / 0.072                | 0.722 / 0.906           | no       |

Five eligible candidates were tied. The same-publisher candidate had the lowest cost. The best eligible candidate was better by 0.0047 B-cubed F0.5 for each fold on average, with a standard deviation of 0.013 over the 10 folds. That difference is in the noise of the folds.

### The package gives the scores of the round

`plan.json` (`implementationCheck`) holds the scores of the design on each full set that is not the exam set. These scores are in-sample on the training sets. The package gives the same scores to 3 decimals on all six sets (`nx run event-grouping:eval`, 2026-10-27):

| Set               | Pair P / R / F0.5     | B-cubed P / R / F0.5  |
| ----------------- | --------------------- | --------------------- |
| anthropic-outlets | 0.641 / 0.257 / 0.493 | 0.938 / 0.853 / 0.919 |
| ecbplus           | 0.884 / 0.786 / 0.862 | 0.947 / 0.792 / 0.912 |
| dev2938           | 0.500 / 0.143 / 0.333 | 0.991 / 0.972 / 0.987 |
| fresh2957         | 0.810 / 0.944 / 0.833 | 0.882 / 0.972 / 0.899 |
| gvc               | 0.961 / 0.712 / 0.898 | 0.989 / 0.848 / 0.957 |
| hlgd-test         | 0.200 / 0.002 / 0.008 | 0.990 / 0.438 / 0.790 |

The conformance test replays the Gun Violence Corpus through the detector, and compares the events with the events of the replica of round #3152. It must find 0 changed pairs.

### Arrival order

The round did not measure the arrival order. The package measured it after the round. Five seeded shuffles of the reports of each publish day gave a B-cubed F0.5 from 0.9186 to 0.9193 on anthropic-outlets (pair F0.5 from 0.490 to 0.493), and 0.9572 for every shuffle on gvc.

### The exam

The exam set is deepmind-outlets: 133 reports in 102 events, labelled and frozen before any design saw it (commit dc1daad). It leaves out the 27 reports that the training set anthropic-outlets also holds, because this round fitted its weights on that set (commit 8c32ca8). The second selection (below) wrote the rule that decides the exam. The exam was scored one time, on 2026-10-27 (commit 82c172c), and design 3152b **passed**:

| Design                   | CoNLL F0.5 | B-cubed F0.5 | Pair precision / recall / F0.5 |
| ------------------------ | ---------- | ------------ | ------------------------------ |
| 3152b                    | 0.883      | 0.960        | 0.793 / 0.411 / 0.669          |
| 3130                     | 0.818      | 0.918        | 0.622 / 0.500 / 0.593          |
| Every report alone       | 0.562      | 0.943        | 0 / 0 / 0                      |
| All reports in one event | 0.100      | 0.017        | 0.006 / 1.000 / 0.008          |

- (a) CoNLL F0.5 of 3152b minus 3130: +0.065, 95% bootstrap interval [+0.001, +0.144], 93 blocks. The interval is above 0, but its low end is near 0.
- (b) 3152b beats both trivial designs.
- (c) gvc −0.001 [−0.012, +0.011] and hlgd-test +0.001 [0.000, +0.004]: neither interval is below 0.

3152b joins fewer real pairs than 3130 (pair recall 0.411 against 0.500), but more of its joins are correct (0.793 against 0.622). F0.5 counts precision two times, so this is the trade that the objective asks for. The research replica scored design 3130 on the exam in the same run, with the constants of the scoreboard pin. The replica gives the accepted events of 3130 on gvc and the package's exam events of 3152b with no changed pair.

## The second selection (3152b)

The first selection used B-cubed F0.5. A design that leaves every report alone gave a higher B-cubed F0.5 than design 3130 on anthropic-outlets (0.940 against 0.812), on dev2938 and on hlgd-test. Thus that score cannot tell a good design from a design that does nothing when most events have one report. The evaluation now uses the scores of coreference research (eval/README.md). The objective of every round is CoNLL F0.5: the mean of the MUC, B-cubed and CEAF-e F0.5.

The second selection wrote its rule before any score (`selection-rule.json`, sha256 `7606921c…`, 2026-10-27T15:16:41Z). It used nested cross-validation on the same folds and only the training sets. It froze `plan.json`, sha256 `dc26dbd8c26341ca4245552d017161307f30b79aef4bc5ba3a171a72a534c479`, at 2026-10-27T15:34:54Z, in `feature-scorer-3152b`.

| Design                                                                                   | CoNLL F0.5, cross-validated |
| ---------------------------------------------------------------------------------------- | --------------------------- |
| 3130                                                                                     | 0.772                       |
| The same-publisher term (chosen)                                                         | 0.822                       |
| The best eligible design: a clean lead, numbers without URLs and the same-publisher term | 0.831                       |

- The same pair score and the same weights won again. The threshold changed to 0.45, the best point of the grid.
- The best eligible design was not better by more than chance: the bootstrap interval of the difference was −0.009 [−0.021, +0.003]. The rule chose the simpler design.
- Every design with a limit on the days of an event made gvc lower than design 3130, so none of them was eligible.

The exam rule (`plan.json` `examVerdict`): the design passes if, on deepmind-outlets, (a) the 95% bootstrap interval of its CoNLL F0.5 minus the CoNLL F0.5 of design 3130 is above 0, (b) it beats the two trivial designs (every report alone, and all reports in one event), and (c) on gvc and hlgd-test, the interval of the same difference is not below 0. When the interval of (a) includes 0, the result is "inconclusive", and design 3130 stays the accepted design.

## Considered Options

- **A limit on the days that one event can cover.** A limit of 1 day gave the best training objective (0.937 alone, 0.949 with the other fixes). But every candidate with a limit made gvc lower than design 3130 (pair F0.5 0.811 to 0.826 against 0.868). The Gun Violence Corpus has follow-up reports many days after the event ([limitation 19](../limitations.md)). A limit splits them. Rejected.
- **Named entities.** They gave 0.921 alone, and the gvc B-cubed F0.5 fell to 0.945. With the other fixes, they were tied but cost the most. The model needs 58 to 101 ms for each report. Rejected.
- **Relative similarity (CSLS and margin).** ECB+ fell to 0.34. Rejected.
- **A clean lead and numbers without URLs.** The rule removes image credits, widget lines and newsletter greetings from the lead, and URLs from the number text. With the same-publisher term, it was the best eligible candidate (0.936). It is within the margin, and it costs more than the same-publisher term alone, so the selection rule did not choose it. A later round can measure it again.
- **The same-publisher term and the publisher mean.** The mean similarity of the reports of one publisher in the window. It was tied (0.933) and costs more. Not chosen.

## Consequences

- A host that knows the publisher must give it. Without publishers, the detector cannot use the same-publisher evidence, and the scores of round #3152 on sets with many publishers do not apply to it.
- The parameters of round #3130 in ADR 0001 are history. The lead rule, the vector text, the shortlist and the window of ADR 0001 are still the parameters of the detector. The threshold is 0.45.
- 3152b is the accepted design of the scoreboard. deepmind-outlets is now a regression set; a later round needs a new exam set.
