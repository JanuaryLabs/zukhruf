# @zukhruf/vector-decisions

> **Status: in progress.** Unit 0 of 16 is done: the package exists, and it has no code yet. The decisions are in [ADR 0001](docs/adr/0001-port-the-library-core-of-venn-at-one-commit-one-unit-at-a-time.md).

A program often needs a decision about a text, not new text: which team owns a ticket, how urgent it is, or if it is a defect. A decision model such as Jev reads the text again for each question. This package answers the same typed questions from vectors. A reader embeds each text one time. Then a small head compares the vector of the text with the vectors of the options. This package is a TypeScript port of the library core of [Venn](https://github.com/markrussinovich/venn-vdm) (commit `7b2042e`).

The package is private: a workspace reaches it through its path. The words are defined in [CONTEXT.md](CONTEXT.md).

## Units

Each unit works and has tests alone, and it composes with the units before it.

| Unit | What it does                                                                                 | Venn source                           | State   |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------- | ------- |
| U0   | The package                                                                                  | -                                     | done    |
| U1   | Reads the tensors of a `.safetensors` file                                                   | `runtime.load_weights`                | planned |
| U2   | Downloads the files of a model at one revision and checks their SHA-256                      | `runtime.model_directory`             | planned |
| U3   | The head: the option logits and the "none" logit of a state                                  | `heads/abstention.py`, `index/*.py`   | planned |
| U4   | The reader: the Classification prefix and the vector cache, around an AI SDK embedding model | `reader.py`, `server.py`              | planned |
| U5   | `DecisionService.decide`: Choice, Score, Noul, IndexApply and prepared questions             | `server.py`                           | planned |
| U6   | An AI SDK decision model over a `DecisionService` (addition: Venn has an HTTP route)         | `decisions.py`                        | planned |
| U7   | Calibration: the temperature fit, on an optimizer that moves out of mteb                     | `heads/calibration.py`                | planned |
| U8   | NearestReference, SetMembership and PopulationShift                                          | `index/decision.py`, `index/shift.py` | planned |
| U9   | The draws of NumPy that the folds need, in `@zukhruf/random`                                 | -                                     | planned |
| U10  | The linear Choice family                                                                     | `heads/linear_choice.py`              | planned |
| U11  | The regress family: ridge and kernel ridge, with an 80% interval                             | `heads/regression.py`                 | planned |
| U12  | Gradients and AdamW for the fixed modules of the heads (addition: Venn uses PyTorch)         | -                                     | planned |
| U13  | The residual Choice family                                                                   | `heads/family.py`                     | planned |
| U14  | The OutcomeService and its heads                                                             | `outcomes.py`, `heads/outcome.py`     | planned |
| U15  | A reader on Transformers.js (addition: Venn reads with PyTorch)                              | `reader.py`                           | planned |
