# A criterion without a description is the abstention, and JSON is the text that Venn writes

Status: Proposed (2026-11-14).

## Context

Venn's Decisions API, `venn.decisions.decide` (`venn/decisions.py:131`), answers choice, score and noul questions with Venn's `DecisionService`. It asks each question as a Choice: the instructions, and an option for each criterion. Then it divides the probabilities by their sum (`venn/decisions.py:180-211`). Venn gives this API as an HTTP route. The AI SDK's `experimental_decide` asks an `Experimental_DecisionModelV4` the same kinds of question, with the name `boolean` for noul, and also `box`. These facts decide the port:

- **A criterion without a description.** In Venn, a choice can have one criterion that is null: the abstention. It is not an option of the Choice. Its probability is the probability of "none", and the probabilities of the other criteria and of the abstention are divided by their sum (`venn/decisions.py:108-111, 115-123, 183-189`). A score or a noul cannot have one. The AI SDK's provider of Jev, whose API Venn copies, sends each choice question to Jev as it is, null criteria too (`@ai-sdk/typesafe-ai` 3.0.40, `dist/index.js:232-238`), and its documentation shows `other: null` as a criterion of a choice (`docs/105-typesafe-ai.mdx:116`). The type of the AI SDK says only "Null means no description" (`DecisionModelV4Question`).
- **JSON.** Venn's `text()` of an object or an array is Python's `json.dumps(value, sort_keys=True, ensure_ascii=False)` (`venn/decisions.py:47`): `", "` between items, `": "` after a key, keys in the order of their code points, and a float under 1e-4 with an exponent of two digits (`5e-05`). The canonical JSON of RFC 8785 (`src/service/canonical-json.ts`, the form of a question handle) has no spaces, sorts keys by UTF-16 code units, and writes `0.00005`. The reader embeds the text, so another text gives another vector.
- **Parts.** Venn's state is one value. The AI SDK's state is a list of text, JSON and file parts. When `@ai-sdk/typesafe-ai` sends a state of parts to Jev, it puts `"\n"` between the parts (`dist/index.js:221`).
- **Refusals.** Venn refuses a question without instructions (`venn/decisions.py:91`), noul criteria that are not both `true` and `false`, a null criterion of a noul or a score, more than one null criterion, and a choice with no criterion that has a description (`venn/decisions.py:98-113`). Venn refuses media parts (`venn/decisions.py:62`). The AI SDK and Jev permit all but the media.
- **Labels.** Venn embeds each criterion with `DecisionService.vector` and asks the Choice with its own labels, `option-0`, `option-1` and so on (`venn/decisions.py:115, 162`). The package's `DecisionService` has no `vector`: an option without a vector is the text of its label.

## Decision

1. `new DecisionServiceModel(service)` is the decision model: the provider `vector-decisions.decision`, the model `venn-1`, and the types `choice`, `score` and `boolean`. For a `box` question, the AI SDK throws `Experimental_DecisionUnsupportedQuestionTypeError` before a model call, and `doDecide` throws the same error.
2. Each question is a Choice of the service, and all the questions of a call go to one `decide`. So the reader embeds the state one time, and a call of more than 32 questions gets Venn's `question_limit`.
3. A null criterion of a choice is the abstention, as Venn and Jev read it: the probability of "none". It comes after the criteria with a description, and all are divided by their sum. A choice accepts one null criterion, and needs one criterion with a description. The reason: Venn and the AI SDK's provider of Jev agree, and the head of Venn is made to give the probability of "none". The probability of "none" of each question is also in `providerMetadata.vectorDecisions.noneProbability`.
4. JSON, in the state, the instructions and the criteria, is the text that Venn's `text()` writes. `canonical-json.ts` stays the form of the handle. The two are not one piece of knowledge: one names a question, and the other is the text that the reader embeds.
5. A state of parts is the text of each part, with `"\n"` between them, as `@ai-sdk/typesafe-ai` joins them. A JSON part is Venn's text of its value, also between other parts, so one value gives one text in every place. A JSON part is data: an object with the key `text` or `vector` is not a state of Venn, as Venn reads it (`venn/decisions.py:148`).
6. The model refuses what Venn refuses. A question without instructions, or with criteria that Venn refuses, throws the AI SDK's `InvalidArgumentError` for `questions.<id>.instructions` or `questions.<id>.criteria`. A file part throws `UnsupportedFunctionalityError`. The checks of the service throw its `ContractError`.
7. The answers are Venn's: the probabilities divided by their sum; for a choice, the first criterion with the largest probability; for a score, the sum of each probability times its level from zero, with the probabilities by level; for a boolean, the probability of true. The result has no `usage`: `DecisionService` counts no tokens, and the AI SDK keeps an unknown count undefined. Venn gives 0 tokens, with the note that it does not count them. `maxOutputTokens` and `reasoning` give an `unsupported` warning.
8. The label of each option is the text of its description, until the service has a port of Venn's `vector` (#4389).

## Consequences

- A program that moves from another decision model gets the abstention for a null criterion, not an option with no description.
- Until #4389, a question with a criterion whose description is "none", or with two criteria of one description, throws the AI SDK's `InvalidArgumentError` for `questions.<id>.criteria`, where Venn answers. The test of Venn's answers is a `todo`.
- The model refuses a choice or a score without instructions, which the AI SDK and Jev permit. If a caller needs them, a later decision can give Venn's default instructions, "What is the topic?".
- The text of a JSON number is Python's text of the number that `JSON.stringify` writes, which Python reads as an int when it has no point and no exponent.
