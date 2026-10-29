# The design is frozen by research round 6

The filter decides with many steps: the score, the calibration, the keyword evidence and the threshold. A test with a few articles cannot show if a change of a step is better. Only labelled streams can show it. Six research rounds (#3195) compared designs on 16 profiles, with every article labelled for every profile by blind annotators. The workspace record [docs/research/relevance-filtering.md](../../../../../docs/research/relevance-filtering.md) tells the history.

The user accepted the bar of non-inferiority on 2026-10-29: a design passes when it is not worse than the reader's typed keyword by more than 0.05 macro T11F, beats the other baselines, and gives calibrated probabilities (Brier skill above 0). Round 6 met that bar, and the design was frozen in `freeze/plan.json` (sha256 `d49b589b…`, 2026-10-29T06:18:09Z), before its exam. The research folder is `~/.codex/visualizations/2026/10/23/01a16a1c-424c-7793-8ca9-02cc1c715d82/relevance-profiles` on the maintainer's Mac.

## Decision

The package implements `desc|binormal+kw` of the plan, and nothing more:

- **Score.** s(x) = cos(x, d), the cosine of the article vector and the description vector. The answers do not move the score; they serve the calibration.
- **Binormal model.** The scores of the stream are standardised by their mean and standard deviation (divided by n). The relevant component starts at the mean and the standard deviation of the taught relevant scores, the other component at the mean and the standard deviation of the stream. The share of relevant articles starts at 0.05 and stays in [1/n, 0.5]. Each standard deviation has a floor of 0.05. Semi-supervised EM keeps each taught score in the component of its answer. It stops after 500 iterations, or when the log likelihood changes by less than 1e-9. If the relevant mean falls to or below the other mean, the fit cannot hold. It also cannot hold when every stream score is equal.
- **Platt.** When the fit cannot hold and the profile has a not-relevant answer, Platt's method on the taught scores gives the probabilities (smoothed targets, Newton steps with a line search). When the taught scores do not rank the answers (AUC at most 0.5), each article gets the mean smoothed target. When the fit cannot hold and there is no not-relevant answer, the keywords decide.
- **Keyword evidence.** logit p += log(P(k|rel) / P(k|stream)) for a matching article, and log((1 - P(k|rel)) / (1 - P(k|stream))) for the others. P(k|rel) = (matching taught relevant + 1) / (taught relevant + 2). P(k|stream) = (matching stream articles + 1) / (stream size + 2). A profile with no keyword has no evidence, so its probabilities stay as the calibration gives them.
- **Threshold.** Accept the m most probable articles, where m maximises 1.25 · (sum of their probabilities) / (0.25 · sum of all probabilities + m) (the plug-in rule for the expected F0.5).
- **No relevant answer.** The profile accepts the keyword matches ([ADR 0001](./0001-a-profile-is-a-value-and-train-decides-on-one-stream.md)).

## The implementation check

The plan froze a record of one run: profile security, the fresh slice, product teaching with N = 10 (`eval/implementation-check/implementation-check.json`, sha256 `3daacace…`). `nx run relevance-filtering:eval -- check` runs it through the package:

| Item                                               | Result                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Shown, taught relevant and taught not-relevant ids | The same                                                         |
| Accepted articles                                  | 196 of 196, and the same decision for each article of the record |
| Probabilities                                      | Max difference 1.6e-7                                            |
| Threshold                                          | Difference 1.5e-7                                                |
| Binormal parameters                                | Max difference 1.5e-8                                            |

The probabilities are not equal to 1e-9, and the cause is the storage, not the design. The research used the vectors as float64 values. A `Collection` stores each unit vector as float32 values ([embeddings ADR 0005](../../../../embeddings/docs/adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)), so each similarity moves by about 1e-8. The frozen research code on the vectors rounded to float32 (`eval/implementation-check/float32-reference.py`) gives the same probabilities as the package to 2e-14, the threshold to 1e-15 and the binormal parameters to 2e-15.

Two details of the port matter at that precision:

- **The sums follow numpy.** The EM stops when the log likelihood changes by less than 1e-9. On the check, that change is 1.0011e-9 at iteration 186 in numpy. A plain loop sums in another order, finds 9.993e-10, and stops one iteration early. The parameters then differ by 1e-6. Thus `sum` follows the pairwise order of `numpy.sum`, bit for bit.
- **Platt solves its 2 × 2 system by LU with partial pivoting**, as `numpy.linalg.solve`.

On the two fresh slices, the package gives the macro T11F of round 6 to 16 digits (0.7014896592253096 against keywordNarrow 0.6559484434821066), the same bootstrap intervals, and the macro Brier skill to 6e-9.

## Considered Options

- **Options for the caller**, such as the threshold or the start share. No caller can measure a change without labelled streams, and the plan froze the values together.
- **Store float64 vectors to reach 1e-9 on the frozen record.** That is a change of `@zukhruf/embeddings`, and it changes no decision of the record.
- **Constants with their provenance.** This option was selected.

## Consequences

- Change a step only with a new research round on labelled streams. Freeze its plan before its test.
- The exam of the plan runs once, through the eval of this package (`--exam`), after the implementation check passes.
- With another embedding model, the similarity scale changes, and the design must be measured again.
