# Structured eval

A harness gives a structured record. A person labels the record that the harness must give. This context compares the two records with one comparison core (ADR 0011).

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

**JSON data**:
The value model of the package, `JsonData` of @zukhruf/python. An int and a float stay apart, and a dict keeps the order of its keys. A JavaScript value or JSON text becomes JSON data at the boundary, through `JsonValue`. A scorer set and a scorer assertion read a stated text as JSON text.

**Unparsed**:
A stated value that is not an object or an array, such as text that is not JSON. An unparsed value has no stated leaves.

**Case**:
What one test gives a scorer besides the stated record: the expected record, its JSON Schema when the scorers need one, and its weight.
_Avoid_: test row, sample (runner words)

**Case reader**:
A rule that reads a case from the plain object that a runner holds for one test, such as `ConfigCase` (the config of an assertion) or `TextVarsCase` (the vars of a test).

**Weight**:
How much one case counts in a weighted average. A case weighs what its test row gives, else 1.

**Path**:
The steps to one value: keys and item positions, such as `offers`, `1`, `value`, `amount`. A path is its steps, not a string. `$.offers[1].value.amount` is only how a path is written.

**Field**:
A path without its item positions, such as `$.offers[*].value.amount`. The package can count per field. A key of a comparison spec writes a field as a JSONPath query (RFC 9535) of name selectors and the wildcard selector.

**Leaf**:
A value at a path that is not an object or an array: a string, a number, a boolean or null.

**Comparison spec**:
The rules to compare two values of one kind: the alignment of each array, the comparator of all leaves, the comparator of each field, and the excluded fields.

**Draft**:
The version of JSON Schema that reads a schema: draft 7 or 2020-12. The `$schema` keyword names it, else it is 2020-12. `JsonSchema` can set it. The validator and the type walk read one schema with the same draft, so one schema has one meaning.

**Pattern**:
A regular expression in a JSON Schema: the value of `pattern`, or a name in `patternProperties`. The package reads it as ECMA-262 with the `u` flag, as JSON Schema says (2020-12 Core §6.4). SOB's evaluate.py reads it with Python's `re`, which gives other answers for some patterns. No SOB schema has a pattern (0 of 10,177, 2026-11-06), so no SOB number depends on it. See #3903.

**Excluded field**:
A field that the walk does not compare.

**Comparison**:
The result of the walk for one stated value and its case: the leaf pairs, the item pairs, and if the stated value is parsed.

**Leaf pair**:
One expected leaf and one stated leaf at the same field, or one leaf with no other side. Each side keeps its own path.

**Alignment**:
The rule that pairs the items of one array: by position or by best match.

**By position**:
The alignment that pairs item 0 with item 0, item 1 with item 1, and so on. It is the default, and SOB's rule.

**By best match**:
The alignment that pairs the items in any order. Of all pairings, it takes the one with the most agreeing leaves (the Hungarian algorithm).

**Ordered array**:
An array whose items pair by position.

**Set array**:
An array whose items pair by best match.

**Match**:
A rule that says if two items of a set array can be a pair, such as "the two quotes are the same sentence".

**Pair**:
One stated item and one expected item that the walk compares leaf by leaf.

**Comparator**:
A rule that says if two leaves agree, such as JSON equality, Python equality, a number in a tolerance, normalized text, or a token overlap.

**JSON equality**:
Two values agree when JSON Schema calls them equal: `1` agrees with `1.0`, and `true` does not agree with `1`. It is the default comparator.

**Python equality**:
Two values agree as Python's `==` says: `true` agrees with `1` and with `1.0`. SOB's caller gives it.

**Matches**:
The counts of one comparison that precision, recall and F1 read: the hits, the stated and the expected. A path match counts the leaf pairs with a value on both sides. A value match counts the leaf pairs whose two values agree. An item match counts the pairs of the items.

**Presence**:
The expected record and the stated record both have a value at one path. The two values can be different. A path match counts presence.

**Scorer**:
An object that gives one ratio for one comparison, such as `new Recall(new ValueMatches())`. A scorer is named by what it measures, not by the benchmark that defined it. It keeps no result.
_Avoid_: metric (a metric adds the values of many records)

**Ratio**:
A part and a whole, such as 2 right values of 3 expected values. Its value is the part divided by the whole, and 0 when the whole is 0.

**F1 ratio**:
The ratio of an F1: its part is 2 × hits, and its whole is the stated and the expected. Its value is 2·p·r/(p + r), as SOB's evaluate.py gives it, so it can differ from the part divided by the whole in the last bit. It is the one exception to the rule of a ratio.

**Token F1**:
The F1 of the words that a stated value shares with its expected value, as SQuAD reads words. It gives partial credit to text.

**Type precision**:
The stated leaves whose type the JSON Schema allows at their path, by the rules of its draft, divided by the stated leaves. It reads the stated record as the harness gave it, also when the record is invalid.

**Gate**:
A scorer whose ratio is 1 of 1 or 0 of 1, such as `SchemaCompliance`. A gate is the penalty whose factor is 1 or 0. A gate says what it checks and why it fails.

**Penalty**:
A factor in [0, 1] for one comparison that multiplies the part of a ratio, as BLEU's brevity penalty multiplies BLEU. The factor 1 is no penalty. A gate is the penalty whose factor is 0 or 1.
_Avoid_: soft gate (a gate is 0 or 1)

**Penalized**:
A scorer whose part is multiplied by the factor of each of its penalties, for each record. Its whole stays.

**Shortfall penalty**:
The penalty `min(1, (value / target) ** power)` of the value of a scorer. It is 1 when the value reaches the target. SOB gives it to image and audio records, with the F1 of the paths, the target 0.90 and the power 2.

**Subset**:
A part of a dataset that the caller scores with its own scorers, such as the modality of SOB (text, image or audio). The caller gives each test the scorers of its subset. A case has no subset.
_Avoid_: modality (a word of SOB), split (train and test are splits)

**Schema compliance**:
The stated record is parsed and agrees with a valid JSON Schema. A scorer that is gated by schema compliance gives an invalid record the part 0 and keeps its whole.

**All matched**:
Every leaf pair of a comparison agrees, and every item has a pair. When it reads null as no value, as `nullIsMissing` says, a null leaf does not count on either side.

**Scorer set**:
A scorecard scorer that holds labelled scorers. It passes when each of its gates holds.

**Scorecard scorer**:
An object that scores one stated record against its case and gives a scorecard, such as `ScorerSet`. It keeps no result.

**Scorecard**:
The result of a scorecard scorer for one record: passed, reason, checks and named ratios.

**Metric**:
A value over many scorecards, such as the means of `Totals` or the interval of `Bootstrap`. A scorer gives the ratio of one record. A metric adds the ratios of many records.
_Avoid_: metric for the number of one record (that is a scorer)

**Ratio of sums**:
The sum of the parts of many ratios divided by the sum of their wholes. Each average of this package is a ratio of sums.

**Totals**:
The ratio of sums of each name over many scorecards.

**Micro average**:
A ratio of the counts of all records added together, such as all right values divided by all expected values. `Totals` gives it for a plain scorer.

**Samples average**:
The mean of the values of the records, as scikit-learn's `average='samples'` takes it. `Totals` gives it for a `SampleAveraged` scorer, because each record then gives its value over 1.
_Avoid_: macro average (scikit-learn's macro average is the mean over the labels, not over the records)

**Scorer assertion**:
A scorer with its weight in the score of the test, the threshold at which it passes, and the metric it reports under. It reads the case from the vars of the test. An assertion module gives it to promptfoo.

**Assertion module**:
The module that promptfoo loads the function of a scorer assertion from. A config names its scorer assertions, and gets JSON assertions with file references (ADR 0013).

**Bootstrap interval**:
The interval of a mean: many resamples draw the scorecards again, with replacement, and two quantiles of their means that the caller chooses, such as the 2.5% and the 97.5%, are its ends.
