# @zukhruf/python

The results of CPython 3.12 in JavaScript, to the last bit: the `sum()` of floats, the `repr()` of a float, `json.loads`, the white space of `str.isspace()`, and the word characters of `\w`. Use it when a TypeScript port must give the same numbers and text as a Python program, such as a benchmark's scorer.

The package is private: a workspace reaches it through its path (ADR 0001).

## Use it

```ts
import {
  type JsonData,
  NeumaierSum,
  PYTHON_SPACE,
  PYTHON_WORD,
  floatRepr,
  loadsJson,
  toJsonParseValue,
} from '@zukhruf/python';

NeumaierSum.of([0.1, 0.2, 0.3]); // 0.6, as sum([0.1, 0.2, 0.3]) in Python
floatRepr(1e16); // '1e+16', as repr(1e16)
const value: JsonData = loadsJson('{"b": 1, "10": 2.0, "a": NaN}');
// Map { 'b' => 1n, '10' => 2, 'a' => NaN }
toJsonParseValue(value); // { '10': 2, b: 1, a: NaN }, for a validator
new RegExp(`[${PYTHON_SPACE}]+`, 'u'); // Python's \s
new RegExp(`[${PYTHON_WORD}]+`, 'u'); // Python's \w
```

| Export             | CPython                                  | What it keeps                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NeumaierSum`      | `sum()` of floats (Python/bltinmodule.c) | Neumaier's compensated sum. It starts at 0 and adds the compensation only when that is not 0 and is finite, so `[1e308, 1e308, -1e308]` gives `Infinity` and `[-0.0]` gives `0`. `add` and `value` give a running sum; `NeumaierSum.of(values)` sums an iterable.                                                                                                                           |
| `floatRepr`        | `repr()` of a float                      | The shortest digits, fixed notation for exponents from -4 to 15, and always a fraction: `1.0`, `1e+16`, `1e-05`, `-0.0`, `nan`, `inf`.                                                                                                                                                                                                                                                      |
| `loadsJson`        | `json.loads`                             | A dict is a `Map` in the order of its keys, and a repeated key keeps its first place and its last value. An int is a `bigint` and a float a `number`, so `1` and `1.0` stay apart. `NaN`, `Infinity` and `-Infinity` are numbers. Text that is not JSON throws a `SyntaxError` (Python's `JSONDecodeError`). An int of more than 4300 digits throws a `RangeError` (Python's `ValueError`). |
| `JsonData`         | the values of `json.loads`               | `null`, `boolean`, `bigint`, `number`, `string`, arrays and `Map`s of them. They are mutable, as in Python, so `Array.isArray` and `instanceof Map` narrow a value.                                                                                                                                                                                                                         |
| `PYTHON_SPACE`     | `str.isspace()`, `\s`, `str.split()`     | The body of a RegExp class. It has U+001C to U+001F, which JavaScript's `\s` lacks, and lacks U+FEFF, which JavaScript's `\s` has.                                                                                                                                                                                                                                                          |
| `PYTHON_WORD`      | `\w` of a `str` pattern                  | The body of a RegExp class: letters, numbers and `_`. It equals CPython 3.12's `\w` for each character of Unicode 15.0. Node knows characters of later Unicode versions, which it reads as `\w` and Python 3.12 does not.                                                                                                                                                                   |
| `toJsonParseValue` | none: the way out of `JsonData`          | The value that `JSON.parse` gives for the same text, for code that reads only plain JavaScript, such as a JSON Schema validator. A dict becomes an object, so its integer-like keys move first. An int becomes the nearest `number`, so an int beyond 2^53 loses digits. The int `-0` gives `0`. Keep the `JsonData`, and convert only where such code reads it (ADR 0002).                 |
| `JsonParseValue`   | none                                     | The type of a value of `toJsonParseValue`: `null`, `boolean`, `number`, `string`, arrays and plain objects of them.                                                                                                                                                                                                                                                                         |

## Documentation

- [ADR 0001: one home for the CPython rules that three places copied, reached through a workspace path](docs/adr/0001-one-home-for-the-cpython-rules-that-three-places-copied.md)
- [ADR 0002: JsonData has one way out, and code takes it only at an edge](docs/adr/0002-json-data-has-one-way-out-at-an-edge.md)
