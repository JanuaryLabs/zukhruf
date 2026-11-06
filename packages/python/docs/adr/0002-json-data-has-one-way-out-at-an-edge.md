# JsonData has one way out, and code takes it only at an edge

`loadsJson` gives `JsonData` without loss: each dict is a `Map` in the order of its keys, and each int is a `bigint`. Five places then turned `JsonData` into plain JavaScript with the same walk. Each place turned an int into the nearest number. The places differed in one thing only, the form of a dict: four places made an object, and one place (the predictions file of `@zukhruf/mteb`) kept a `Map`.

Ezz asked: "is this one thing so important that cannot be like others. why it is the way it is", and "should it not be loseless everywhere?". The answer: the `Map` was there for the order of the keys. In a predictions file of MTEB, the order of the documents selects the documents when two scores are equal at the `topK` cut. A JavaScript object moves integer-like keys first. `JsonData` already keeps the order, so the reader of the predictions file needs no conversion. Ezz chose: "yes remove the cause".

So code keeps the `JsonData` as long as it can. It converts only at an edge: the place where it gives the value to code that reads only plain JavaScript, such as a JSON Schema validator or classes that hold numbers. The package gives the one conversion, `toJsonParseValue`. It gives the value that `JSON.parse` gives for the same text, and it has no option. Its result has the type `JsonParseValue` (Ezz chose the precise type, not `unknown`), so mteb's scores need no cast.

The conversion loses data on purpose:

- A dict becomes an object, so its integer-like keys move first.
- An int becomes the nearest number, so an int beyond 2^53 loses digits.
- The int `-0` gives `0`. `JSON.parse` gives `-0`, but an int of Python has no negative zero.

The members of `JsonData` are mutable (`JsonData[]`, `Map<string, JsonData>`), as the lists and dicts of `json.loads` are in Python. TypeScript cannot narrow a readonly array or a `ReadonlyMap` with `Array.isArray` or `instanceof Map`: the readonly type stays in the false branch. So three places wrote their own guards (`isDict`, `isList`). Ezz chose "Remove the cause", and the guards are gone.

## Considered Options

- Keep the five walks. One rule then has five places, and the places already differed.
- One conversion with an option for the form of a dict, as the `dict_converter` of Pyodide's `toJs`. The option keeps a difference that no rule of the domain needs.
- One conversion with no option, which code calls only at an edge. This option was selected.
- For the guards: keep `JsonData` readonly and export `isDict` and `isList`. Each consumer then pays for a type that the domain does not ask for.

## Consequences

- The reader of an mteb predictions file is lossless. It writes an int beyond 2^53 exactly, as Python writes it.
- A JSON Schema validator still compares the nearest number for an int beyond 2^53 (cfworker, Ajv). Python's jsonschema compares the exact int.
- A consumer that must not change a value marks its own field `readonly`.
