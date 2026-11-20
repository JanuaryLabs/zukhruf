# Recipe: Give a JsonData value to a schema validator at an edge

**Use case.** `loadsJson` gives `JsonData`: each dict is a `Map` in the order of its keys, and each **int** is a `bigint`. A schema validator such as [zod](https://zod.dev/) reads only plain JavaScript, so it cannot read a `Map`. When code converts the value at the start, all the code after it loses the order of the keys and the exact ints. So keep the `JsonData`, and call `toJsonParseValue` only at the **edge**: the place where the validator reads the value ([ADR 0002](../adr/0002-json-data-has-one-way-out-at-an-edge.md), commit `41b44982`).

**What you need.** A JSON text, `loadsJson` and `toJsonParseValue` from `@zukhruf/python`, and a zod schema.

## The steps

1. Read the text with `loadsJson`, and keep the `JsonData` that it gives.
2. Read the dicts and lists of the `JsonData` with `instanceof Map` and `Array.isArray`. They narrow the type, because the members of `JsonData` are mutable.
3. Where the validator reads the value, give it `toJsonParseValue(value)`, not the `JsonData`.

## The program

The program reads a dict that has an int beyond 2^53 and a dict with integer-like keys. It prints the keys and the int of the `JsonData`. Then it gives the `JsonData` to a zod schema, and after that the value of `toJsonParseValue`.

```ts title="edge.ts"
import { z } from 'zod';

import { type JsonData, loadsJson, toJsonParseValue } from '@zukhruf/python';

const text =
  '{"id": 12345678901234567891, "scores": {"b": 0.5, "10": 1.0, "2": 0.25}}';

// Keep the JsonData: its dicts are Maps in the order of the keys, and its
// ints are bigints.
const value: JsonData = loadsJson(text);
if (!(value instanceof Map)) throw new TypeError('The text is not a dict.');
const scores = value.get('scores');
if (!(scores instanceof Map)) throw new TypeError('scores is not a dict.');
console.log('JsonData keys:', [...scores.keys()].join(', '));
console.log('JsonData id:', value.get('id'));

// The edge: zod reads only plain JavaScript.
const report = z.object({
  id: z.number(),
  scores: z.record(z.string(), z.number()),
});
const direct = report.safeParse(value);
console.log(
  'zod on the JsonData:',
  direct.error?.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  ),
);

const converted = report.safeParse(toJsonParseValue(value));
if (!converted.success) throw converted.error;
const parsed = converted.data;
console.log('keys after the edge:', Object.keys(parsed.scores).join(', '));
console.log('id after the edge:', parsed.id);
console.log(
  'JSON.parse gives the same:',
  JSON.stringify(parsed) === JSON.stringify(JSON.parse(text)),
);
```

Output (zod 4.6.7):

```
JsonData keys: b, 10, 2
JsonData id: 12345678901234567891n
zod on the JsonData: [
  'id: Invalid input: expected number, received undefined',
  'scores: Invalid input: expected record, received undefined'
]
keys after the edge: 2, 10, b
id after the edge: 12345678901234567000
JSON.parse gives the same: true
```

## What the output shows

- The `JsonData` keeps the keys in the order of the text, `b, 10, 2`, and the int exactly, `12345678901234567891n`.
- zod refuses the `JsonData`. A `Map` holds its entries, not properties, so zod finds no `id` and no `scores`.
- After `toJsonParseValue`, zod accepts the value, and the value loses two things. The integer-like keys move first, `2, 10, b`, as in each JavaScript object. The int becomes the nearest number, `12345678901234567000`, so it loses digits.
- The value is the one that `JSON.parse` gives for the same text, as `src/to-json-parse-value.test.ts` proves for each kind of value.

## Things to know

- **Convert only at the edge, and keep the `JsonData` for all other code.** Code that needs the order of the keys or the exact int reads the `JsonData`. The predictions file of `@zukhruf/mteb` needs the order: when two scores are equal at the `topK` cut, the order of the documents selects them ([ADR 0002](../adr/0002-json-data-has-one-way-out-at-an-edge.md)).
- **Call `toJsonParseValue` in the function that calls the schema.** The scorers of the offers evals do this: a `Match` takes two `JsonData` values and calls `schema.safeParse(toJsonParseValue(value))` in `canPair`.
- **A validator compares the nearest number for an int beyond 2^53.** zod reads `12345678901234567000` in the output above, and the JSON Schema validators cfworker and Ajv do the same. Python's `jsonschema` compares the exact int ([ADR 0002](../adr/0002-json-data-has-one-way-out-at-an-edge.md), Consequences).
- **The int `-0` gives `0`.** `JSON.parse` gives `-0`, but an int of Python has no negative zero (`src/to-json-parse-value.test.ts`).
- **`toJsonParseValue` has no option.** It always gives a plain object for a dict. Its result has the type `JsonParseValue`, so the code that reads it needs no cast. See the [README](../../README.md#use-it).
