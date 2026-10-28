# The similarity source is a port, and the parameters belong to one source

The detector must decide if two reports tell about one real occurrence. The research tried many ways to make that decision. This record lists each way that the research tried, what each way did, and why the detector uses vectors from EmbeddingGemma 2. It also tells what you can replace, and what you must measure again when you replace it.

Read this record before you change the similarity source, add a model, or change a parameter. [ADR 0001](./0001-the-parameters-are-frozen-by-research-round-3130.md) lists the parameters. The [limitations](../limitations.md) list what the design does wrong.

## Considered Options

Each row is a way to tell if two reports are about one occurrence. The numbers come from the research rounds in the workspace record [docs/research/event-grouping.md](../../../../docs/research/event-grouping.md).

| Way                                        | Models that the research tried                                               | Result                                                                                                                                                              | Use in the detector                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Embedding similarity                       | EmbeddingGemma 2 (Q8_0, llama.cpp b11836)                                    | The 80 nearest reports held 584 of 590 real pairs of HLGD (#2948). Similarity alone joined 1 of 14 real pairs and made 11 false joins (#2938).                      | The shortlist, and one of the three terms of the pair score. |
| Word matching (BM25)                       | MiniSearch 7.2.0                                                             | The 80 nearest reports held 543 of 590 real pairs. Words and vectors together held 585 (#2948). A rare-word term made F1 lower on all test sets (#3124).            | None.                                                        |
| Cross-encoder for duplicate questions      | `cross-encoder/quora-distilroberta-base`                                     | 0 of 14 real pairs, although its known positive check passed (#2938).                                                                                               | None.                                                        |
| Reranker                                   | Qwen3-Reranker-0.6B (Q8_0, the rerank endpoint of llama.cpp)                 | Recall on HLGD went from 28.0% to 39.7%, but precision fell from 77.1% to 54.7%. It joined different Claude models and different Python release candidates (#2944). | None.                                                        |
| Entailment (NLI) and zero-shot classifiers | `Xenova/nli-deberta-v3-xsmall`, `MoritzLaurer/ModernBERT-base-zeroshot-v2.0` | They did not pass the checks for the fresh tests (#2944).                                                                                                           | None.                                                        |
| Small generative verifier                  | LiquidAI LFM2.5-1.2B-Instruct (QAD-Q4_0)                                     | It made no "same occurrence" decision on the real saved pairs. It called an easy paraphrase uncertain (#2944).                                                      | None.                                                        |
| Local LLM judge                            | Qwen3.5-9B (Q4_K_M)                                                          | 33 of 36 real pairs with 1 false join on the fresh #2957 set, but about 5.9 s for each pair in each direction (#2957). The user refused this cost on 2026-10-26.    | None.                                                        |
| Named entities                             | `Xenova/bert-base-NER`                                                       | +0.003 B-cubed F0.5 in cross-validation, under the margin of 0.005 (#3130).                                                                                         | None.                                                        |
| Numbers that agree or disagree             | No model: the numbers of the two leads                                       | Without them, F1 was the lowest on ECB+ and Multi-News (#3124).                                                                                                     | Two of the three terms of the pair score.                    |
| Exact-text fingerprints (MinHash)          | Not tried                                                                    | They find copies of one text, for example one wire story that many outlets publish. They do not find a report in other words.                                       | None.                                                        |

### Models trained for event coreference

Research models for cross-document event coreference exist, but they work on event mentions, the words in a sentence, not on full reports. A search of Hugging Face on 2026-10-27 found these:

- `biu-nlp/cdlm` (Caciularu et al., 2021): a base language model for many documents. It must be trained again on coreference data before it can decide anything.
- `ahmeshaf/ecb_tagger_seq2seq`: it finds the event words in ECB+ text. It does not group reports.

The search found no model that takes two reports and tells if they are about one occurrence. One open option is a cross-encoder that is trained on labeled pairs of reports: ECB+, the Gun Violence Corpus, HLGD and a labeled live set (#3142). That needs a research round. It also needs a cost check, because the model must score about 80 pairs for each new report.

## Decision Outcome

**The similarity source is a port.** The detector asks the `Vectors` port four things: keep the vector of this report, give the nearest reports of one report, give the nearest reports of each report in a date range, and give the similarity of two reports. The `Collection` of `@zukhruf/embeddings` answers them. Another embedding model, a word index, or a mix of the two can answer them too, and the detector does not change.

**The parameters belong to one source.** The weights and the threshold learned the similarity scale of EmbeddingGemma 2 on the vector text of ADR 0001. Another source gives another scale. For example, 30 degrees Celsius and 30 degrees Fahrenheit are very different temperatures. A detector with a new source and the old parameters makes wrong decisions. Thus a new source needs a new research round on the evaluation sets (#3145), and it gets its own parameters.

**The constructor takes a design.** A `Design` (`src/design.ts`) holds the source and its parameters as one unit: the name of the embedding model, the lead rule, the vector text, the shortlist size, the window, the threshold and the weights of the pair score. The constructor has no default design, so each caller names the design that it uses, for example `design: design3152b`. A design is a value, not code, so the evaluation can run the accepted design and a new design in one run (#3189). The design names its model, but the detector cannot see the model of the vectors. The caller must give vectors of that model.

**The repository builds a design.** `nx run event-grouping:fit -- <round>` fits a design from the selection rule of a round and the training sets (eval/README.md). It runs the detector of the package, not a copy, so the design that the fit chooses is the design that the package runs. Thus another embedding model gets its own fitted weights and threshold from the same code.

## Consequences

- A new source needs a new design: fit it with `nx run event-grouping:fit`, then score it with `nx run event-grouping:eval`.
- Before you change the source or a parameter, run `nx run event-grouping:eval` ([eval/README.md](../../eval/README.md)). Do not use a set as a fresh test after a round has scored it once: the runner scores an exam set one time only, and then the set is a regression set.
- A new source alone does not fix the false joins between the posts of one publisher (limitation 20). There, every post shares the same names, so every similarity is high.
- If you add a model in the table above, add its row with the round that measured it.
