# Decide leaves out the fields of Venn's own reader, and keeps Venn's rules of an answer

Status: Proposed (2026-11-14).

## Context

Venn's `DecisionService.decide` (`venn/server.py:912`) reads a request and gives a decision. Venn has one reader: EmbeddingGemma 2 at one revision. So the request can name a `model` and a `revision`, and Venn refuses another reader with the code `embedder_revision` (`venn/server.py:923`). The decision gives a `vector_tag` and a `model`, which name that reader.

In this package, the reader is the AI SDK embedding model that the caller gives to `DecisionService.load` (U4). The package cannot see the revision of that model. `load` checks only that the `config.json` of the head names Venn's reader.

Venn also takes forms of input that the types of this package can refuse before a call: a request that is not an object (`request_shape`), a question that is not an object (`question_shape`), a matrix as the instructions vector (`instructions`), and an option that is a bare vector or an object without a label, whose label is then its index.

Three rules of Venn's answer are not the only correct choice:

- A Noul question divides the "none" part by its temperature, but the option part by `choice_temperature` always (`venn/server.py:1100`). With a calibration (U7), the two parts can have two temperatures.
- Of two labels with the largest probability, the first one is the answer (`np.argmax`, `venn/server.py:1135`).
- A Choice or Score answer is "none" when the confidence is less than the threshold (`<`, `venn/server.py:1138`). A Noul answer is "none" when the probability of "none" is equal to or more than the threshold (`>=`, `venn/server.py:1114`).

## Decision

1. `decide` has no `model` and no `revision` in the request, and no `vector_tag` and no `model` in the decision. No request gives the code `embedder_revision`. The reason: the reader is the caller's model, so these fields would name a model that the package does not choose.
2. An option is a text, or `{ label, vector }`. Each option has a label, so each answer names its option with a word that the caller gave.
3. The types refuse what Venn refuses with `request_shape`, `question_shape` and `instructions`. No code of the package checks these at run time. The package keeps the run-time checks for values that a type cannot refuse, such as a threshold of 1.5 or a type `Ranking` from JavaScript.
4. The package keeps the three rules of Venn's answer above, as Venn has them. The golden tests compare the answers with Venn's own answers (ADR 0001, rule 6), and another rule would give other answers for the same request.

## Consequences

- A caller that wants a check of its reader's revision makes that check before `decide`. The vector cache keeps the vectors of each model apart, because its key names the model (U4).
- U7 keeps the two temperatures of a Noul question apart: the calibrated temperature for "none", and `choice_temperature` for the options.
- The tests do not pin a confidence that is equal to its threshold: no probability of the fixture is equal to a threshold. The code compares as Venn's code does.
- If a caller needs a bare vector as an option, a later decision can add it with a label that the caller gives.
