# Field errors have five classes, and the field diff pairs items as the scorer pairs them

Status: accepted in part (Ezz, 2026-11-27, #6108: "Add partial now"). The test of a partial leaf waits for review with the code.

`FieldErrors` is built (`src/structured/report/field-errors.ts`, #6108). It compares each answer with the comparer of the eval through `Comparer#compare`, as `ScorerSet` does, and reads the leaf pairs and the item pairs of the `Comparison`, with the leaf options of the eval's scorers (`nullIsMissing`, as offers' scores set it), so that a leaf is classed as the scores count it. A leaf is partial when `BagOfWords.of` of each side, the words that `TokenF1` reads, share a word (`shared(...).hits > 0`). A row is a field, such as `$.offers[*].kind`, or the items of an array, such as `$.offers items`, in the order the walks first reach them. The class of a paired item reads the leaves under the item on either side, and a paired item with no leaf is correct. The claim names the row with the most errors. `FieldDiff` of one run is built (`src/structured/report/field-diff.ts`, #6108): it compares each answer as `FieldErrors` does, shows the answers with the most error leaves first as `ValuePairs`, one pair for each leaf at its path with positions, and leaves out the answers with no error. Its form of a `RunPair` comes with the building blocks of a run pair.

## Context

A page of structured answers shows which fields fail (Kleister's table of fields, DocILE's field types, nervaluate's report of each entity type) and the answer beside its case (SOB Table 10, by hand). promptfoo stores the ratios of each answer but not the pairs that gave them. The surveyed tools diff the text of two values (Braintrust, LangSmith, Phoenix, promptfoo); none knows the fields.

jsondiffpatch 0.7.7 diffs JSON by field, but it pairs the items of an array by position, or by a hash that the caller gives. On two offers in the other order with one wrong amount, it reported 6 changed fields with no hash and paired by `kind` with a hash, which fails when two offers have one kind. `ByBestMatch` (ADR 0002 of this folder) paired the three offers by content and found one wrong field (probe of 2026-11-27). A diff that pairs in another way than the scorer shows errors that the score does not have.

SemEval 2013 task 9.1, as nervaluate reports it, has five classes: correct, incorrect, partial, missed and spurious. Its partial is an entity whose span overlaps the expected span but whose bounds differ.

## Decision

1. **`FieldErrors` and `FieldDiff` compare each answer again with the comparer of the eval**: the `TreeWalk` with the spec of its scores. They make no model call.
2. **A leaf has one of five classes.** Correct: both sides have it, and the comparer of its field says they agree. Partial: both sides have it, they disagree, and they share a word, read as `TokenF1` reads words (SQuAD's `normalize_answer`). Incorrect: both sides have it, they disagree, and they share no word. Missed: only the expected side has it. Spurious: only the answer has it.
3. **An item of an array has one of five classes.** Correct: paired, and every leaf is correct. Partial: paired, with some leaves correct and some not. Incorrect: paired, and no leaf is correct. Missed: an unpaired expected item. Spurious: an unpaired stated item.
4. **`FieldErrors` counts each class for each field** (a field is a path without positions, such as `$.offers[*].kind`), and for each array.
5. **`FieldDiff` shows the answers with the most errors first**, each one as `ValuePairs` (core ADR 0008): the expected item beside the paired stated item, each leaf marked by its class, and the unpaired items on their own side. Of a `RunPair`, it shows the two answers of the test beside the case.

## Consequences

- Partial does not change a score: the scores count agreement by the comparer of each field. A partial leaf is incorrect for `ValueMatches`; the class only shows how close it was.
- A number shares a word with another number only when they are the same text, so 5000 and 2500 are incorrect, not partial.
- An excluded field of the spec (offers excludes `$.offers[*].duration` from `values_f1`) is not shown as an error. A host that wants it shown gives a spec without the exclusion.
- The correct leaves of a run add up to the hits of its `ValueMatches` scores, since both count with the same pairs.
