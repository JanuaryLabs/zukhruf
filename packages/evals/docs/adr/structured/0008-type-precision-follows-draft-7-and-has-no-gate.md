# Type precision follows JSON Schema draft 7 and has no gate

Status: amended by [ADR 0011](0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md) (accepted 2026-11-06). Type precision follows the draft of the schema, the same draft as the validator; SOB's caller sets draft 7, so this ADR's walk stays for SOB. `SchemaTypeWalk` reads the steps of a `Path`, and it is the one walk of the types: `SchemaTypes` is deleted. `LeafTypePrecision` is `TypePrecision`, and `whenNoneStated` is the `whenEmpty` of `SampleAveraged`.

Status: amended by [ADR 0009](0009-a-scorer-gives-a-value-for-one-answer-and-a-metric-adds-many.md). Its words changed: a metric of this ADR is a scorer now, a scorer is a scorecard scorer, `MetricScorer` is `ScorerSet`, `MetricAssertion` is `ScorerAssertion`, and `CanonicalEquality` is `ExactMatch`.

`LeafTypePrecision` gives the share of the stated leaves whose type the JSON Schema allows at their path. Its first form ported the walk of SOB's evaluate.py (`schema_type_for_path`): it read only `properties` and `items`, it read a type as Python names it (`1.0` is a float), and it gave 0 for a schema that is not valid. Ezz chose a complete walk on 2026-11-04 ("One complete walk"), and asked on 2026-11-06: "what is correct. our draft7 or sob's?".

SOB's own data answers. evaluate.py checks each record twice: its validator (Python's jsonschema, draft 7) says whether the record agrees with the schema, and its walk says whether each leaf has an allowed type. On 18 of the 38 lines of the golden fixture, its validator accepts the record, but its walk calls a leaf's type wrong. The walk breaks six rules of draft 7:

- A path that the schema gives no type allows any type.
- An absent `additionalProperties` allows any value.
- A list of types allows each listed type, `null` included.
- A `$ref` names the schema to read (draft-handrews-json-schema-01, section 8.3).
- `prefixItems` is not draft 7, so an absent `items` allows any item.
- An integer is any number with a zero fraction, so `1.0` is an integer (validation section 6.1.1).

So the walk follows draft 7 (Ezz: "Fully Draft 7"). `SchemaTypeWalk` reads `properties`, `patternProperties`, `additionalProperties`, `items`, `additionalItems`, `anyOf`, `oneOf`, `allOf`, `$ref`s, `type`, `const` and `enum`. It does not read `if`, `then`, `else`, `not` or `dependencies`, so they restrict nothing. The walk is its own class, because it is a JSON Schema concept: it knows nothing of a metric or a benchmark.

The walk resolves a `$ref` as the validator does. `Draft7Schema` builds one lookup with cfworker's `dereference`: it holds each schema by its URI, from the `$id`s and the JSON Pointers of the schema, and the draft-07 meta-schema at its URI, as the registry of jsonschema holds it. The validator and the walk read each `$ref` through this lookup, so they always read the same schema. Before, the walk read only a local `$ref` such as `#/definitions/a`. When the validator learned the meta-schema URI (backlog #3806), a valid record under a `$ref` to that URI got a type precision of 0. One lookup removes that class of disagreement.

The metric has no gate (Ezz: "step back. do not focus on the consumer today. what is proper?"). A record that the schema accepts has no leaf of a type that the schema refuses, so it always gives 1. The metric therefore grades a record that the schema refuses: how much of it still has allowed types. A gate on validity makes it a copy of validity, 1 for a valid record and 0 for any other. evaluate.py shows type precision only behind that gate (evaluate.py:291-295, 302-309). That is SOB's choice, and its callers compose it: `Gated(new LeafTypePrecision({ whenNoneStated: 0 }), new SchemaCompliance())`. A stated value with no leaf has no type to check, so the caller gives that value (`whenNoneStated`; evaluate.py gives 0), as decision 5 of the convergence asks (backlog #3786).

## Considered Options

- SOB's walk. It contradicts SOB's own validator on 18 of 38 lines.
- A complete walk with Python's types. It still calls `1.0` at an `integer` path wrong, where the validator accepts it.
- A draft 7 walk, and a metric with no gate. This option was selected.

## Consequences

- evaluate.py is no longer the oracle for type precision. The golden test uses evaluate.py's own `schema_compliance` in its place: by draft 7, SOB's gated type precision equals it, or `whenNoneStated` for a stated value with no leaf. This proves one direction only, that the walk refuses no type of a valid record; `leaf-type-precision.test.ts` proves the rules one by one.
- The summary numbers that average type precision (its mean and intervals, and two categories) have no oracle, so the golden test leaves them out.
- On the real SOB records, the values differ from evaluate.py wherever SOB's walk contradicts its validator. The offers-evals kit lists them.
- A schema that is not valid can reach the walk. A `patternProperties` key that is not a regular expression matches no name, and a `$ref` that names nothing allows no type.
