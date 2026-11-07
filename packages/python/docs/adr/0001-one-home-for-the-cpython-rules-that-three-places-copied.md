# One home for the CPython rules that three places copied, reached through a workspace path

Status: the private exception of this ADR ended on 2026-11-07. The package is public, because `@zukhruf/evals` is public and depends on it (workspace ADR 0001, rule 7: a zukhruf package is a dependency, not a peer; backlog #3888, Ezz: "Public").

`@zukhruf/mteb` ports MTEB, and its results must match those that MTEB writes in Python. It wrote the CPython rules that this needs: the compensated `sum()` of floats, the `repr()` of a float, a `json.loads` that keeps the order of keys, and the white space of `str.isspace()`. `@zukhruf/structured-eval` copied four of them for its port of the scorer of the Structured Output Benchmark, and recorded the copies (its docs/copied-code.md, backlog #3770). The offers-evals repository then copied three of them again. That made three places for each rule, and workspace ADR 0001, rule 2, moves code into one home at the third place.

This package is that home. It holds only the rules that three places had, and it takes their identical parts:

- `NeumaierSum` is the running sum of structured-eval, with `NeumaierSum.of` for the one-call form that mteb and offers-evals use.
- `floatRepr` is the same function in all three places.
- `loadsJson` is the visitor of structured-eval, which reads an int as a `bigint`, with the token rewrite that mteb and structured-eval share character for character. It also takes the 4300-digit limit of offers-evals, because Python 3.11 and later refuse such an int.
- `PYTHON_SPACE` is the same set of characters in all three places.

What differs stays with its consumer. mteb reads an int as a JavaScript number, so mteb converts the `bigint`s. Two rules have only two places: the code-point order of strings (mteb, structured-eval) and Python's `==` on JSON values (structured-eval, offers-evals). They stay copies until a third place needs them. `json.dumps` has a different configuration in each place, and the spelling of `None` in `str()` and the tokens of a benchmark belong to that benchmark.

npm has no package that gives these results (checked on 2026-11-05). stdlib-js's `gsumkbn` gives `NaN` for `[1e308, 1e308, -1e308]` and `-0` for `[-0.0]`, where CPython gives `inf` and `0.0`. Its `regexp-whitespace` lacks U+001C to U+001F and has U+FEFF. `lossless-json`, `json-bigint`, `@johnhenry/pyjson` and the `context.source` of `JSON.parse` move integer-like keys first or refuse `NaN`. No package writes the `repr()` of a float.

The package depends on `jsonc-parser`, whose visitor gives the keys in order and the source text of each number. Ezz chose to keep it (2026-11-05): it reads 45,080 texts as CPython does, and a scanner of our own would be new code to prove. A base package can have npm dependencies, as `pool` and `coprocess` do.

The package is private, and a workspace reaches it through its path, as `@zukhruf/structured-eval` is reached. Ezz chose this on 2026-11-05: "I vote for private". This breaks workspace ADR 0001, rule 8, in the same way as structured-eval's ADR 0001.

## Considered Options

- Keep the copies. Each fix then needs three edits, and the copies already differed in one rule (the 4300-digit limit).
- An npm package. None gives these results (above).
- One package with the rules that three places copied. This option was selected.

## Consequences

- A repository outside this workspace gives the exact path of the package in its workspaces, as for structured-eval, or a `file:` dependency.
- When a second rule reaches its third place, it moves here.
- When the package must be used outside these repositories, publish it and delete the exception.
