# SOB parity is a separate, lossless port of evaluate.py

Status: replaced in part by ADR 0005. The metrics are now classes named by what they measure, and SOB's report is composed by its caller. The rules below about Python's results still hold.

Ezz wants numbers that compare with the Structured Output Benchmark (SOB). SOB pairs list items by position and takes a mean over records. ADR 0002 pairs set items by maximum matching and adds the counts of all records together. One flag on the spec would mix the two methods in one scorer. So SOB parity is a separate scorer, `SobScorer`, with its own summary, `SobSummary`.

The port follows evaluate.py at commit da785a8 of interfazeai/sob. It gives the 11 values of each record, and the summary of evaluate.py: 10 metric means, 5 category scores and their bootstrap intervals, without and with weights. Where Python and JavaScript differ, the port keeps the Python result:

- The port reads a SOB line with the visitor of `jsonc-parser`, as `jsonLoadsInOrder` of @zukhruf/mteb does. The visitor gives the source text of each number, so `1` stays an int (a bigint) and `1.0` stays a float (a number). Each dict is a Map, so the key order stays: `JSON.parse` puts integer-like keys first, and the order changes the float sums of evaluate.py. The port adds Python's NaN and Infinity.
- The port keeps Python's `==` (`True == 1`), its float repr (`1.0`, `1e-05`), its Unicode word boundaries and its code-point key order.
- The bootstrap uses `python-random`, which gives the draws of CPython's `random.Random(seed)`, `randrange` included. `@stdlib/random-base-mt19937` cannot do this: it turns a seed array of one word into an integer seed (factory.js).
- `SobRunnerScorer` reads the text of a harness as SOB's runner does (`json.loads`, else the text). `SobScorer` reads a string as unparsed, as evaluate.py does.

The port uses the words of this package: SOB's `ground_truth` is the expected record, and its `candidate_response` is the stated record.

## Considered Options

- A flag on the spec. It mixes two methods in one scorer.
- A port on JavaScript values only. `1` and `1.0` become one number, so Faithfulness Score and Perfect Response Rate differ when a record has `1.0`.
- A separate, lossless port. This option was selected.

## Consequences

- A stated record that is given as an object has lost the difference between `1` and `1.0`. For exact parity, give the JSON text through `SobRunnerScorer`, or read the line with `SobLine.parse`.
- The port scores text records only. Image and audio records need the other coverage gate of evaluate.py. Add it when a consumer scores them.
- The port is pinned to da785a8. A later SOB change needs a new comparison with evaluate.py.
- The port was compared with the outputs of evaluate.py on 400 records of two real runs (LiquidAI LFM3 1.7B, thinking off and on, 2026-11-03), record by record: each of the 11 values of each record is the same float, and each mean and bootstrap interval of the summary, without and with weights, is equal. These records have no NaN, no integer-like keys and no invalid schema, so those paths are not compared yet.
- NOTICE keeps SOB's MIT licence.
