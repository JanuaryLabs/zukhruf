# Limitations

The research for event grouping found these limits. They apply to this package. The numbers are the numbers of the [workspace record](../../../docs/research/event-grouping.md), which keeps the history of each round and the limits that apply to all designs (1 to 12, 15 to 17). Read a limit before you change the design, and add the result of each new round to the workspace record.

## 13. The boundary of an event has no written rule

**What happens.** Some errors are disputes about the event boundary, not scorer errors.

**Evidence.** In round #2957, a lawsuit filing and a later motion in the same case were labeled two events. Every method joined them. Two reports of one tornado outbreak, one with a death and one with "no deaths yet", were labeled one event.

**Cause.** "One event" can mean one action or one case. Data sets choose differently.

**Before you change it.** Write the boundary rule for the product before you label data: action level or case level, and how to treat updates. Use the same rule in every label set.

## 14. The input text can be incomplete or noisy

**What happens.** A short or noisy text gives a wrong lead and wrong numbers.

**Evidence.** Web extraction returned only a 97-character description for one page, and a paywall preview for another (#2952). The lead rule removes URL lines. But it measures the URL share on the sentence without spaces, so a URL in the middle of a sentence takes the rest of the sentence with it, and the rule drops the whole sentence.

**Before you change it.** Make extraction report an incomplete page (#2952). A partial page is close to a headline-only report (limitation 18). Change the lead rule only with a new round: the weights learned its output.

## 18. A headline-only report gets no join

**What happens.** Without a guard, the design puts almost all headline-only reports into a few large events. With the guard, each headline-only report is alone in its event ([ADR 0003](./adr/0003-a-headline-only-report-never-joins-another-report.md)).

**Evidence.** On the HLGD test set, B-cubed F0.5 was 0.284 against 0.819 for the baseline. Pair F0.5 was 0.100 against 0.572, with 6,326 false joins (#3132).

**Cause.** Dataset shift: the design learned the similarity scale of title-and-lead text. Two titles get higher similarities, so too many pairs pass the threshold. A title also has few numbers, so the number features give no disagreement evidence.

**Before you change it.** A second model trained on titles, selected by the shape of the input, can give joins to headline-only reports. It needs a new round.

## 19. Late follow-up reports start a new event

**What happens.** A report that comes more than 7 publish days after its event does not join it.

**Evidence.** On the Gun Violence Corpus, 63 of the 100 false splits were more than 7 days apart. One example: an arrest reported 93 days after the shooting (#3133).

**Cause.** The shortlist and the window keep only 7 days. No date feature was trained, because only one fitting set had dates.

**Before you change it.** Get training data with dates and late follow-ups. Then learn how the date gap changes the pair score, instead of a hard 7-day limit. A longer window costs more in each clustering (limitation 21).

## 20. Look-alike occurrences close in time still join

**What happens.** Different occurrences of one kind, a few days apart, can join.

**Evidence.** Most of the 22 false joins on the Gun Violence Corpus were shootings of teenagers 6 to 7 days apart. 127 of the 510 documents mention more than one incident. The research gave each document the incident with the most labeled mentions.

**Cause.** The pair score has no place or person feature. Named entities added only 0.003 in cross-validation, under the 0.005 margin, so the design does not use them.

**Before you change it.** Test place and person agreement again on data with many look-alike occurrences. Write the rule for a report of several occurrences (limitation 13).

**Live evidence from one publisher (2026-10-27).** The detector got the 297 dated posts of anthropic.com/news (May 2021 to October 2026), with EmbeddingGemma 2 through llama.cpp. It made 279 events, and 18 of them have two posts. A reading of the titles finds 5 correct events, for example a launch post and its technical post on the same day. It finds 9 false joins of different announcements on one topic a few days apart, for example "Introducing Claude Opus 4.7" and "Introducing Claude Design by Anthropic Labs" one day apart. 4 events are open to argument. That is 28% to 50% correct, against 0.918 pair precision on the Gun Violence Corpus. Every post of one publisher shares names such as "Anthropic" and "Claude", so their similarity is high, and their numbers seldom disagree. This is dataset shift (limitation 4) in a new direction: the design learned reports of external occurrences from many publishers. These titles are a reading by one person, not labeled data. The posts, the script and the result are in the context-compiler session scratchpad (`anthropic-news/`).

## 21. A clustering at production size takes seconds to minutes

**What happens.** Each new publish day clusters the whole window again. The cost grows with the square of the window size. At the volume of a news aggregator, one clustering takes about 3 minutes.

**Evidence.** Round #3130 measured 0.68 ms for each report for the grouping step, but the daily windows of the Gun Violence Corpus are small. Backlog #3131 and #3137 measured one clustering on a synthetic window: 768-dimension vectors with a shared direction, topics and events of 3 reports, through the `Collection` of `@zukhruf/embeddings` in memory, on an Apple M4 Pro with Node.js 26.

| Reports in the window | First measurement | After the faster cosine (51eed3d) | With one neighbour graph of the window |
| --------------------- | ----------------- | --------------------------------- | -------------------------------------- |
| 1,001                 | 8.2 s             | 3.1 s                             | 1.0 s                                  |
| 3,500                 | 71 s              | 30 s                              | 9.6 s                                  |
| 14,000                | not measured      | not measured                      | 175 s                                  |

The events did not change: 334 events at 1,001 reports and 1,167 at 3,500, with at most 3 reports in an event. At 14,000 reports, the add of one publish day of 2,000 reports took 248 s. That time includes the clustering and one `nearest` call for each new report.

**Cause.** The clustering asks the vectors port for one neighbour graph of the window. The graph decodes each vector once, and the clustering uses the similarities of the graph for the pair scores. But the graph still compares each report with each report in its window. Thus one clustering calculates the square of the window size in similarities, and sorts all the reports of a window for each report.

**Before you change it.** Measure one clustering at the window size of the real feeds before you choose the window. A shorter window or another schedule needs a new research round ([ADR 0001](./adr/0001-the-parameters-are-frozen-by-research-round-3130.md)).

## 22. Small leaks in the cross-validation

**What happens.** The research calculated the centering mean from all fitting folds, so each fold saw a little of its own test data.

**Before you change it.** Calculate the mean inside each fold. This leak affects only centered similarity, and centered similarity lost. The design uses raw cosine.

## The events of the latest publish day are provisional

**What happens.** Between two clusterings, a report joins an event by online assignment. Another arrival order of the same reports can give other events until the day closes.

**Cause.** The detector clusters the window when the first report of a new publish day arrives. A quiet feed keeps the events of its last day provisional until its next report ([ADR 0002](./adr/0002-the-window-is-clustered-again-on-each-new-publish-day.md)).

## The parameters need EmbeddingGemma 2

**What happens.** With another embedding model, the similarities have another scale, and the pair scores are not correct.

**Cause.** The weights learned the similarities of EmbeddingGemma 2 (Q8_0) on the text `title: <title> | text: <title>\n<lead>` ([ADR 0001](./adr/0001-the-parameters-are-frozen-by-research-round-3130.md)).

## A changed report is not grouped again

**What happens.** `add` skips a report whose id the detector has already. A corrected text does not change its vector, its numbers or its event.
