# registerQuestion takes no name, and its handle is the SHA-256 of the RFC 8785 JSON of the question

Status: Proposed (2026-11-14).

## Context

Venn's `DecisionService.register_question(name, question)` (`venn/server.py:854`) prepares a question and gives a handle. A request then asks the question with `question_ref`. Three facts of Venn's code decide how the package ports it:

- No code reads `name`. `register_question` gives it to `prepared_question`, which does not read it either. The HTTP route `POST /questions/{name}` takes it from the path.
- The handle is the SHA-256 of `json.dumps(question, sort_keys=True)` without the threshold. That is Python's JSON, with Venn's snake_case names, such as `instructions_vec` and `row_cap`. The handle names the question in the memory of one service, and nothing stores it or compares it with another service.
- `register_question` takes a question with a threshold and drops the threshold. A decision with the handle gives its own threshold, or none.

## Decision

1. `registerQuestion(question)` has no `name`. A parameter that no code reads changes no answer.
2. The handle is the SHA-256, in hexadecimal, of the canonical JSON of RFC 8785 (JCS) of the question without its threshold, with the package's camelCase names. The same question gets the same handle, also with its keys in another order or with another threshold, as in Venn. The handle is not Venn's handle. `src/service/canonical-json.ts` writes the canonical JSON with the algorithm of RFC 8785, appendix A, and its tests are the samples of the RFC. The npm package `canonicalize`, which the RFC names, writes the same JSON, but no other package of the repository needs one, and a dependency would add a package for 15 lines.
3. The type of `registerQuestion` refuses a threshold. A caller from JavaScript can still send one, and the package drops it, as Venn does.
4. A decision with a `questionRef` asks the registered question again: the package checks it and reads its vectors from the vector cache, into which `registerQuestion` embedded its texts. Venn keeps the prepared question in memory instead.
5. `stream_required` keeps Venn's code and status 413, but its message does not name Venn's route `/index-apply`: `decide` answers at most 512 rows.

## Consequences

- The golden tests do not compare handles. In the fixture, a `questionRef` names a registered question, and each side puts its own handle there. The fixture says if two questions get the same handle in Venn, and the tests check the same for the package.
- A decision with a handle makes no model call for the texts of the question, but it reads them from the vector cache again. If the package later keeps the prepared question in memory, as Venn does, the answers stay the same.
- U8 adds `streamIndex`, which takes a `questionRef` too.
