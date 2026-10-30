# The parameters are frozen by research round #3130

**Superseded in part by [ADR 0005](./0005-research-round-3152-adds-a-same-publisher-term-and-fits-the-weights-again.md).** Round #3152 fitted the weights again and added a same-publisher term. The values of `INTERCEPT` and of the terms in this record are those of round #3130, and they are history. The other parameters, the vector text and the rule to change a parameter only with a new research round are still valid.

The detector decides with many numbers: the lead rule, the size of the shortlist, the window, the weights of the pair score and the threshold. A small change to one of them can change many events, and a test with a few reports cannot show if the change is better. Only a research round on a labeled corpus can show it.

Research round #3130 chose all of them on fitting data, and then froze them in its `plan.json` before it scored its test set. The sha256 of that `plan.json` is `5ad0b727f8ae67a1f25bd25719e550952ab1449e3dce1fad551714f63a3ade4f`. The round kept its files in `~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/feature-scorer-3130` on the maintainer's Mac. The workspace record [docs/research/event-detection.md](../../../../../docs/research/event-detection.md) tells the history of all rounds.

The pin of scoreboard entry 3130 (`eval/scoreboard.json`) holds each parameter as a field of a `Design` (`src/design.ts`):

| `Design` field        | Value                                      | `plan.json` key           |
| --------------------- | ------------------------------------------ | ------------------------- |
| `lead.sentences`      | 2                                          | `leadRule.sentences`      |
| `lead.minWords`       | 5                                          | `leadRule.minWords`       |
| `lead.minLetterRatio` | 0.6                                        | `leadRule.minLetterRatio` |
| `lead.maxUrlShare`    | 0.5                                        | `leadRule.maxUrlShare`    |
| `lead.urlPattern`     | `(?:https?://\|www\.)\S*`                  | `leadRule.url`            |
| `shortlistSize`       | 80                                         | `design.k`                |
| `windowDays`          | 7                                          | `design.windowDays`       |
| `threshold`           | 0.5                                        | `design.threshold`        |
| `pairScore`           | the weights, means and standard deviations | `design.model`            |

The vector text is part of the design too (`vectorText`). The round embedded `title: <title> | text: <title>\n<lead>` with EmbeddingGemma 2 (Q8_0, llama.cpp b11836). This is the document prompt of EmbeddingGemma. The weights learned the similarity scale of these vectors. Thus the detector gives this text to the vectors port, and the caller must use the same model.

The round also used `ml-hclust` 4.0.0 `agnes` with the method `average`, and so does the detector.

## Considered Options

- **Options for the caller.** A caller could set the threshold or the window. But no caller can measure the effect of a change without a labeled corpus, and the weights are valid only for the threshold that the round chose with them.
- **Constants with their provenance.** This option was selected. Since #3184, one `Design` value holds the constants, and the caller gives it to the detector ([ADR 0004](./0004-the-similarity-source-is-a-port-and-the-parameters-belong-to-one-source.md)).

## Consequences

- Change a parameter only with a new research round. Freeze its `plan.json` before it scores its test set, and put its result in the workspace record.
- A conformance test replays the Gun Violence Corpus of the round through the detector, and compares the events with the events of the round. It must find 0 changed pairs. The test runs only on a machine that has the files of the round.
- With another embedding model, the similarity scale changes, and the pair scores are not correct. Limitations 4 and 18 of the workspace record show this dataset shift.
- The research cut corpus text that came in tokens (ECB+, the Gun Violence Corpus) back into text with a detokenizer before the lead rule. That step prepares a corpus. It is not part of the detector: a caller gives text.
