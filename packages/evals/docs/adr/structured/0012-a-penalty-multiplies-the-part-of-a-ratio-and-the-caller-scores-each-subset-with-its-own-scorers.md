# A penalty multiplies the part of a ratio, and the caller scores each subset with its own scorers

Status: Accepted 2026-11-06 by Ezz (backlog #3894), as a whole. It amends [ADR 0011](0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md): `Penalized` replaces `Gated`.

## Context

SOB has three subsets: text, image and audio. SOB calls them modalities. Its dataset gives each subset as one config (`load_dataset("interfaze-ai/sob", "image")`, sob-bench README.md:67-68). evaluate.py reads one response file for one modality: `--modality`, or `infer_modality` from the path of the file (evaluate.py:89-94, 128-129, 158-173).

These facts are from evaluate.py at commit da785a8:

- `compute_coverage_gate(modality, structure_coverage)` is at evaluate.py:615-618. For text, it gives 1.0 when `structure_coverage >= 0.95`, else 0.0 (:616-617). For image and audio, it gives `min(1.0, (structure_coverage / 0.90) ** 2)` when `structure_coverage > 0`, else 0.0 (:618). For a value in [0, 1], the `> 0` guard changes nothing, because `(0 / 0.90) ** 2` is 0.
- evaluate.py:303 calls it with `raw_path_set_f1`: the F1 of the paths before any gate (:286-288, `f1_from_counts`).
- The factor multiplies two metrics only: `leaf_value_em = raw_leaf_em * hardening * coverage_gate` (:305) and `value_token_f1 = raw_value_token_f1 * hardening * coverage_gate` (:306). `hardening` is 1.0 or 0.0 (:302). It also multiplies `hier_path_recall`, `path_set_f1` and `type_precision` (:307-309), but the coverage factor does not.
- Through those two metrics, the factor goes into two categories: "Long Context Extraction" and "Multi-Context Linking" (CATEGORIES, :38-52). It also goes into the leaderboard columns "Val.Acc." and "Faithful." (scripts/build_leaderboard.py:47-48) and into the Overall mean of the columns (:130-134). The `coverage` of build_leaderboard.py (:107-108, :135) is a different number: the records that a model has, divided by 5,324.

So evaluate.py multiplies a value by two factors. One factor is 0 or 1. The other factor is in [0, 1].

The package can give the first kind only. CONTEXT.md says: a gate is a scorer whose ratio is 1 of 1 or 0 of 1. `Gated` returns the ratio, or `Ratio(0, whole)` when a gate fails (src/paths/scorers/gated.ts:20-25). offers-evals gives every record the text gate: `covered = new AtLeast(new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 }), 0.95)` (offers-evals src/evals/default-test.ts:37-40), in `field_recall` (:92-100) and `token_f1` (:105-115). offers-evals 85fe9de reads the 324 image and audio records too. The end-to-end oracle of backlog #3894 found the error: on 9 records of LFM3, text and image agree with evaluate.py, but audio with thinking on does not (`field_recall` 0, SOB 0.0160).

The golden fixture has this case already. generate.py calls `evaluate_file(responses, "text")` (src/paths/fixtures/sob-evaluate/generate.py:59). On 2026-11-06 we ran evaluate.py on the same 46 lines as `"image"`, in a scratch folder. Three records then give different values, and every other value stays the same:

| `path_set_f1` | text `leaf_value_em` | image `leaf_value_em` | image `value_token_f1` |
| ------------- | -------------------- | --------------------- | ---------------------- |
| 0.5           | 0.0                  | 0.308641975308642     | 0.308641975308642      |
| 0.9           | 0.0                  | 0.9                   | 0.9                    |
| 0.3333…       | 0.0                  | 0.034293552812071325  | 0.034293552812071325   |

## Decision

1. A **penalty** is a factor in [0, 1] for one comparison. The factor 1 is no penalty. `Penalty` is an abstract class (Template Method): a subclass gives `factor(comparison)`. A penalty is also a scorer: its ratio is `Ratio(factor, 1)`.
2. A gate is the penalty whose factor is 0 or 1. `Gate` extends `Penalty`. Its factor is 1 when it holds, else 0. A gate still says what it checks (`holds`) and why it fails (`explain`), so a `ScorerSet` still makes a check of each gate.
3. `new Penalized(scorer, ...penalties)` multiplies the part of the ratio of its scorer by each factor, in the order of the arguments, for each record (Decorator). The whole stays. When the product is 1, it returns the ratio of the scorer as it is. A factor outside [0, 1] throws a `RangeError`. `Penalized` replaces `Gated`, because the two classes hold the same rule. evaluate.py also writes the gate and the soft factor as one product (:305-306).
4. `new ShortfallPenalty(scorer, { target, power })` gives `min(1, (value / target) ** power)`, with the value of its scorer. Its factor is 1 when the value reaches the target. Below the target, the factor falls with the power of the fraction of the target. The constructor throws a `RangeError` for a `target` or a `power` that is not more than 0. It uses the arithmetic of evaluate.py:618, so it gives the same bits.
5. A **subset** is a part of a dataset that the caller scores with its own scorers, such as the modality of SOB. The package has no class for a subset. The caller holds the subset of each test and gives each test the scorers of its subset. Under promptfoo, a test gets them in its own `assert` list: promptfoo 0.125.1 adds the `assert` of the test after the `assert` of `defaultTest` (`prepareTestCaseForEval`, `dist/src/evaluator-BxCmvGtv.js:8860`). Without a runner, the caller picks the `ScorerSet` of the subset. A `Case` does not get a subset.
6. SOB's caller composes the coverage factor of each subset. Text gets `new AtLeast(coverage, 0.95)`. Image and audio get `new ShortfallPenalty(coverage, { target: 0.9, power: 2 })`. `coverage` is `new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 })`: `raw_path_set_f1`. The README shows the composition.

### The order of the decorators

`Penalized` goes outside `SampleAveraged`. evaluate.py multiplies the value of a record (:305-306). `Penalized(SampleAveraged(…))` gives `Ratio(value × factor, 1)`, so it gives the same product. The other order gives a different number. A text record with no expected leaf has `raw_leaf_em` 1.0 (:566-567) and the factor 0, so SOB gives 0. `SampleAveraged(Penalized(…), { whenEmpty: 1 })` sees the whole 0 and gives 1.

### What a factor does to each average

- Samples average. A record gives `Ratio(v × f, 1)`. `Totals` gives Σ(v·f) / n. That is the mean of `leaf_value_em` in `summarize_rows`. With a weight w, `Ratio.times` gives Σ(v·f·w) / Σw, the weighted mean of SOB.
- Micro average. A record gives `Ratio(hits × f, expected)`. `Totals` gives Σ(hits·f) / Σ expected: each hit counts with the factor of its record, and each expected value stays in the denominator. A gate gives the same result with f = 0 or 1, as `Gated` does today.
- `F1Ratio`. With the factor 1, `Penalized` returns the `F1Ratio`, so its value keeps the bits of evaluate.py (ADR 0011). With the factor 0, the value is 0. With a factor between 0 and 1, `Penalized` gives a plain `Ratio(2·hits·f, stated + expected)`. Its value is part / whole, so it can differ from f × 2pr/(p + r) in the last bit. No SOB number depends on this: SOB multiplies the value of a record, which is `SampleAveraged`.

## Considered Options

- (a) A soft factor inside `Gated`. CONTEXT.md says that a gate is 0 or 1, and `ScorerSet` makes a check of each gate. A factor of 0.31 does not pass or fail. So a soft "gate" makes a check with no meaning.
- (b) `Penalized` beside `Gated`. Two classes then hold one rule: "a factor multiplies the part, and the whole stays". Each fix goes into two classes.
- (c) The case holds its subset, and a scorer picks a scorer by the subset (a Strategy keyed by `case.subset`). A case reader reads the subset from the vars, such as `vars.modality`. Three problems: a `Case` of a dataset with one subset holds a filler value; a subset with no scorer fails only when a record of it is scored; and a typed subset needs a type parameter on `Case`, `Comparison`, `Scorer` and `TreeWalk` for one caller. No precedent below picks a metric per record. Each one picks the metrics per task or per run.
- (d) The penalty reads the modality. The package then learns a word of SOB. ADR 0011 says that SOB is a configuration in its caller.
- (e) One promptfoo config for each modality. evaluate.py does this: one run for one modality. But the offers-evals SOB eval gives one leaderboard row from one run of 5,324 records (85fe9de), so three configs break its summary.
- (f) Options 1 to 6 of the Decision. This option was selected.

## Consequences

- `Gated` goes. Its callers use `Penalized`: the golden test, the README, `src/paths/scorer-set.test.ts`, `src/paths/scorers/gated.test.ts`, and offers-evals `src/evals/default-test.ts`. The removal goes through the coding:remove-code skill.
- `Gate` extends `Penalty`, so each gate is a penalty. `AtLeast` is the text gate of SOB.
- offers-evals: `default-test.ts` gives the assertions of each modality, typed as `Record<Modality, …>` with the `Modality` type of `src/summary/policy.ts:143`, so TypeScript finds a modality with no assertions. `src/evals/sob/dataset.ts` (`testOf`, :147-171) gives each test the assertions of its modality, and the SOB config gives no shared `assert`. The offers eval (`src/evals/offers/promptfooconfig.ts`) keeps the text assertions in its `defaultTest`. The scorers then do not read `vars.modality` (02d826e), so the build removes it. `metadata.modality` stays, because the summary reads it. `dataset.ts` is the file of the peer session of the SOB run. Its run uses a frozen copy, but the build tells that session first.
- The oracle of the build is the end-to-end oracle of #3894 (`~/.claude/scratch/offers-evals-sob-run/oracle_e2e.py`): the stored LFM3 answers become SOB response files, and evaluate.py and offers-evals score them. It must report 0 different cells for text, image and audio. The answers are stored, so the build scores them again and does not run the model.
- The golden test gets an image oracle. generate.py also calls `evaluate_file(responses, "image")` on the same 46 lines and writes its rows and summary. The golden test then checks the image composition. The three records of the Context give the factors 0.3086…, 1 (at the target) and 0.0342…. The fixture changes only with Ezz's go.
- `ShortfallPenalty` gets a unit test for the target (the factor is 1), for a value above the target, for 0, and for the bits of `(value / target) ** power` against Python.

## Precedents

Sources fetched on 2026-11-06.

- BLEU (Papineni et al., ACL 2002, section 2.2.2): "we introduce a multiplicative brevity penalty factor". BP is 1 when c > r, else e^(1−r/c), and BLEU = BP · exp(Σ wₙ log pₙ). So BP is a factor in [0, 1], and 1 is no penalty. BLEU computes BP over the whole corpus, not for each sentence.
- sacrebleu, `sacrebleu/metrics/bleu.py`, `BLEU.compute_bleu`: `bp = math.exp(1 - ref_len / sys_len) if sys_len > 0 else 0.0`, and `score = bp * math.exp(…)`. It has a guard for 0, as evaluate.py:618 has.
- METEOR (Banerjee and Lavie, 2005, section 2): Penalty = 0.5 · (chunks / unigrams matched)³, and Score = Fmean · (1 − Penalty). The factor is a power of a fraction, as `ShortfallPenalty` is.
- Google's NMT (Wu et al., 2016, section 7, equation 14): the coverage penalty cp(X; Y) = β · Σᵢ log(min(Σⱼ pᵢ,ⱼ, 1.0)) is added to a log probability. As a factor of the probability, it is Πᵢ min(Σⱼ pᵢ,ⱼ, 1)^β: a power of a coverage, with 1 as its top. SOB's factor has the same form: min(1, coverage / 0.90)². It ranks beams; it is not an eval metric.
- lm-evaluation-harness, docs/task_guide.md: each task has its own `metric_list`. A group adds the metrics of its subtasks (`aggregate_metric_list`, `weight_by_size` for a micro or a macro average). The guide gives no way to pick a metric per document.
- HELM, `src/helm/benchmark/run_spec.py`: a `RunSpec` holds one `scenario_spec` and its `metric_specs` ("What to evaluate on"). `groups` is "for aggregation".
- inspect_ai: a `Task` has one `scorer` (scorers.html). `grouped(accuracy(), "category")` "applies a given metric to subgroups of samples defined by a key in sample `metadata`" (metrics.html). The metadata groups the report; it does not pick the scorer.
- Hugging Face Datasets, "Load a dataset from the Hub", section Configurations: "These sub-datasets are known as _configurations_ or _subsets_". SOB gives its modalities so (README.md:67-68).
- Coinages: `Penalized` and `ShortfallPenalty` are names of this package. "Penalty" and "penalty factor" are BLEU's words, and "subset" is the word of Hugging Face Datasets.
