# Structured eval

A harness gives a structured record. A person labels the record that the harness must give. This context compares the two records.

## Language

**Record**:
One structured value, such as the offers of one web page.
_Avoid_: output, response (they are runner words)

**Expected record**:
The record that a person labelled for one test.
_Avoid_: ground truth, gold (two words for one thing)

**Stated record**:
The record that the harness gave for that test.
_Avoid_: prediction, actual

**Case**:
What one test gives a scorer or a scorecard scorer besides the stated record: the expected record or value, its JSON Schema when the scorer needs one, and its weight.
_Avoid_: test row, sample (runner words)

**Scorer**:
An object that gives one number for one stated value and its case, such as `LeafExactMatch`. A scorer is named by what it measures, not by the benchmark that defined it. It keeps no result.
_Avoid_: metric (a metric adds the values of many records)

**Scorecard scorer**:
An object that scores one stated record against its case and gives a scorecard, such as `RecordScorer`. It keeps no result.

**Scorer set**:
A scorecard scorer that holds labelled scorers. The value of each scorer is a ratio of the value over 1, under its label.

**Scorecard**:
The result of a scorecard scorer for one record: passed, reason, checks and named ratios.

**Ratio**:
A part and a whole, such as 2 right values of 3 expected values. Its value is the part divided by the whole, and 0 when the whole is 0.

**Ratio of sums**:
The sum of the parts of many ratios divided by the sum of their wholes. Each average of this package is a ratio of sums.
_Avoid_: mean of ratios (that is a macro average)

**Totals**:
The ratio of sums of each name over many scorecards.

**Weight**:
How much one case counts in a weighted average. A record case weighs 1. A JSON case weighs what its test row gives, else 1.

**Path**:
The keys and the item positions to one value, such as `offers[1].value.amount`.

**Field**:
A path without its item positions, such as `offers[].value.amount`. The package counts per field.

**Spec**:
The rules to compare two records of one kind: the alignments, the comparators, the ignored fields and the JSON Schema.

**Alignment**:
The rule that pairs the items of one array: by position (an ordered array) or by the best match (a set array).

**Ordered array**:
An array whose items pair by position.

**Set array**:
An array whose items pair by the best match, in any order.

**Match**:
A rule that says if two items of a set array can be a pair, such as "the two quotes are the same sentence".

**Pair**:
One stated item and one expected item that the package compares field by field.

**Comparator**:
A rule that says if two values of a field agree: exact, a number in a tolerance, normalized text, or token F1.

**Metric**:
A value over many scorecards, such as the means of `Totals` or the interval of `Bootstrap`. A scorer gives the number of one record. A metric adds the numbers of many records.
_Avoid_: metric for the number of one record (that is a scorer)

**Gate**:
A scorer whose value is 0 or 1, such as `SchemaCompliance`. A gate extends `Gate` and says only what it checks. `Gated` multiplies a scorer by its gates for each record.

**Leaf**:
A value at a path that is not an object or an array: a string, a number, a boolean or null.

**Scorer assertion**:
A promptfoo assertion object that gives the value of one scorer: its name, its weight in the score of the test, and the threshold at which it passes. A TypeScript config lists it in its defaultTest. It reads the case from the vars of the test.

**Bootstrap interval**:
The 95% interval of a mean: many samples draw the scorecards again, with replacement, and the interval spans the middle of their means.

**Counts**:
For a field: the expected values, the stated values, the present values and the right values. For a set array: the expected items, the stated items, and the pairs.

**Presence**:
The expected record and the stated record both have a value at one path. The two values can be different.

**Token F1**:
The F1 of the words that a stated value shares with its expected value. It gives partial credit to text.

**Micro average**:
A ratio of the counts of all records added together, such as all right values divided by all expected values.
_Avoid_: mean score (a mean of per-record ratios is a macro average)

**Validity**:
The stated record agrees with the JSON Schema of the spec. An invalid record counts as a record that stated nothing.

**Type safety**:
The share of stated values whose type is the type that the JSON Schema gives their path. It reads the stated record as the harness gave it, also when the record is invalid.

**Perfect record**:
A stated record whose every field is right and whose every item has a pair. When the spec has a JSON Schema, the record must also be valid.
