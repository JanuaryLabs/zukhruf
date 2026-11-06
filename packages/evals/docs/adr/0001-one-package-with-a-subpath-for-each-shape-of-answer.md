# One package, with a subpath for each shape of answer

Status: Proposed, for review (design on paper, 2026-11-06).

## Context

On 2026-11-06, a search found eight evals in four repositories: offers-evals, the offers and the page kinds of startup-credits, the SQL eval of text2sql, the ambient replay, the event-detection eval, the relevance-filtering eval and memory-retrieval-eval. Ezz wants promptfoo to run them: "I would prefer not to do everything myself, that's why I created the scorers." So the package owns the scorers, and promptfoo owns the runner, the store and the viewer. Each eval moves beside its old eval and takes its place a little at a time (a Strangler Fig).

The answers of these evals have different shapes, and each shape has a different set of scorers:

| Shape of answer  | Scorers                                         | Reference implementation                                   | Places that have the knowledge today                                                                                  |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Structured value | leaf and item matches, token F1, type precision | none in common (SOB, DocILE, AWS Stickler)                 | `@zukhruf/structured-eval`                                                                                            |
| Labels           | accuracy, precision, recall, F-measure, Brier   | scikit-learn `sklearn.metrics`                             | mteb `dependencies/sklearn.ts`, relevance-filtering `eval/metrics.ts`, startup-credits `eval/kind-score.ts`: 3 places |
| Ranked list      | average precision, nDCG, recall at k            | trec_eval (pytrec_eval)                                    | average precision: mteb `pytrec-eval.ts`, mteb `sklearn.ts`, relevance-filtering `ranking.ts`                         |
| Partition        | MUC, B³, CEAF-e, BLANC, V-measure               | the CoNLL reference scorer; scikit-learn `metrics.cluster` | event-detection `metrics/`; mteb V-measure                                                                            |

Ezz said: "it doesn't make sense to blend all scorers with each other." He chose one package with an import path for each shape ("One package, subpaths"), the plural name, and a public package ("Public").

## Decision

`@zukhruf/evals` has one concept: it scores the answers of an eval against their labels. Each shape of answer is a family with its own import path:

- `@zukhruf/evals`: the core that every family uses. A scorer gives a ratio for one input. A gate, a scorer set, a scorecard, `Totals` and `Bootstrap` add and combine the ratios (ADR 0002).
- `@zukhruf/evals/promptfoo`: the adapter for promptfoo.
- `@zukhruf/evals/structured`: `@zukhruf/structured-eval` moves in, with its ADRs, after the six slices of #3884.
- `@zukhruf/evals/classification`: new (ADR 0003).
- `./ranking` and `./clustering` come later.

These rules hold:

1. A family imports only the core. It never imports another family. The adapter imports only the core.
2. A family follows its reference implementation bit for bit, and a golden test proves it. The name of a family is the shape of its answers, never the name of its reference implementation.
3. A third-party dependency of a family is an optional peer, as the drivers of `@zukhruf/testing` are (its ADR 0002). So a user of `./classification` does not install the JSON Schema validator of `./structured`. The tests of each family run where the optional peers of the other families cannot be resolved.
4. A zukhruf package is a dependency, not a peer (workspace ADR 0001, rule 7). The core depends on `@zukhruf/python` and `@zukhruf/statistics`.
5. The package is public. Thus the exceptions of `@zukhruf/structured-eval`, `@zukhruf/python` and `@zukhruf/statistics` (each one's ADR 0001: private, reached through a workspace path) end with the first release.
6. The package has no benchmark, no runner and no LLM judge.

### Workspace ADR 0001

Rule 1 of workspace ADR 0001 says: "A package has one concept. … Two concepts that exist without each other are two packages." That ADR also turned down "one package, with an import path for each area", because the areas need different dependencies.

This package keeps rule 1. Its one concept is the scoring of answers against labels. A family is an area of that concept, as a database is an area of `@zukhruf/testing`. The families share the core contracts and the adapter, and a family has no use without them. The reason for the turned-down option does not apply here: rule 3 keeps the dependencies of each family apart, as testing ADR 0002 does for its drivers.

### Now, later and never

| When  | What                                                                 | Trigger                                                     |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Now   | the core, `./promptfoo`, the move of `./structured`                  | Ezz reviews this paper, and #3884's six slices land (#3888) |
| Now   | `./classification`                                                   | after #3888 (#3889); the knowledge is in 3 places           |
| Later | `./ranking`                                                          | a promptfoo eval ranks something                            |
| Later | `./clustering`                                                       | a third place compares two partitions                       |
| Later | SQL execution accuracy                                               | a second SQL eval                                           |
| Later | the tools of the frozen-design evals: roles, label hashes, the exam  | backlog #3261, at a third eval                              |
| Never | a package that mixes the scorers of all shapes, benchmarks, a runner | —                                                           |

## Name

The libraries of evaluators use the plural, and some split their scorers by import path: autoevals 0.4.1, openevals 0.2.3 (`./llm`, `./code/typescript`), `@mastra/evals` 1.10.11 (`./scorers/prebuilt`, `./checks`) and `@arizeai/phoenix-evals` 2.7.1. The frameworks use "eval" as a prefix (lm-eval, deepeval) or another word (inspect-ai, evaluate, ragas). inspect-evals uses the plural for a collection of benchmarks, and this package has no benchmark. npm had no package with the names `@zukhruf/eval`, `@zukhruf/evals` or `@zukhruf/scoring` (checked on 2026-11-06).

## Considered Options

- **One package that holds all scorers, with no families.** Ezz turned it down: the scorers of one shape have no meaning for another shape.
- **One package for each family, and one for the core.** It keeps rule 1 by the letter, but four or five packages share one set of contracts and one adapter, and each user installs three packages to score one eval.
- **One package, with an import path for each shape.** torchmetrics (`classification/`, `retrieval/`, `clustering/`) and `sklearn.metrics` do the same. This option was selected.

## Consequences

- `@zukhruf/structured-eval` goes away. Its users change their imports: offers-evals #3892, context-compiler #3893.
- mteb takes its classification metrics from `./classification` (#3890), and the relevance-filtering eval takes its F0.5 and Brier from it (#3891).
- A new family starts at the third place that has its knowledge (workspace ADR 0001, rule 2).
