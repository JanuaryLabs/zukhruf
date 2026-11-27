# Field errors and the field diff pair items as the scorer pairs them

Status: proposed (2026-11-27, #6108). Design for review: no code yet.

## Context

A report of structured answers shows which fields fail (Kleister's table of fields, DocILE's field types, nervaluate's report of each entity type) and the answer beside its case (SOB Table 10, by hand). promptfoo stores the ratios of each answer but not the pairs that gave them. The surveyed tools diff the text of two values (Braintrust, LangSmith, Phoenix, promptfoo); none knows the fields.

jsondiffpatch 0.7.7 diffs JSON by field, but it pairs the items of an array by position, or by a hash that the caller gives. On two offers in the other order with one wrong amount, it reported 6 changed fields with no hash and paired by `kind` with a hash, which fails when two offers have one kind. `ByBestMatch` (ADR 0002 of this folder) paired the three offers by content and found one wrong field (probe of 2026-11-27). A diff that pairs in another way than the scorer shows errors that the score does not have.

## Decision

1. **`FieldErrors` and `FieldDiff` compare each answer again with the comparer of the eval**: the `TreeWalk` with the spec of its scores. They make no model call.
2. **The classes are SemEval 2013 task 9.1's, as nervaluate names them: correct, incorrect, missed and spurious.** A leaf on both sides is correct or incorrect; a leaf only on the expected side is missed; a leaf only in the answer is spurious. An item of an array is missed when it is an unpaired expected item, spurious when it is an unpaired stated item, and correct or incorrect by its leaves. SemEval's "partial" applies only to a comparator of overlap (`TokenOverlapAtLeast`), and waits for one that needs it.
3. **`FieldErrors` counts each class for each field** (a field is a path without positions, such as `$.offers[*].kind`), and for each array.
4. **`FieldDiff` shows the answers with the most errors first**, each one as value pairs (core ADR 0008): the expected item beside the paired stated item, each leaf marked by its class, and the unpaired items on their own side. In `PairReport` it shows the two answers of the test beside the case.

## Consequences

- An excluded field of the spec (offers excludes `$.offers[*].duration` from `values_f1`) is not shown as an error. A host that wants it shown gives a spec without the exclusion.
- The classes count with the same pairs as `ValueMatches`, so the correct leaves of a run add up to the hits of its `values_*` scores.
