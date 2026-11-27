# A host composes a page of sections, and each section is built from its input

Status: accepted (Ezz, 2026-11-27, #6108: "By input", then "Compose a Page"). `Page` is built in `src/report/page.ts` (7043d988), and these building blocks with it: `Summary`, `Slices`, `RepeatSpread`, `ValidityGap`, `CostAndLatency`, `Verdicts`, `TestsMoved` and `Trend` of `./report`, and `FieldErrors` and `FieldDiff` (of a `RunLog` and of a `RunPair`) of `./structured`.

## Context

Ezz chose ten kinds of view for evals of structured answers (docs/report.md, "The building blocks"). Each kind reads one run, two runs on the same tests, or many runs. When a view can be built depends on that input, not on the view: a summary can be built when its run ends, a verdict only when both runs exist. Ezz: "it depends on the reporter".

The paper first had three fixed reports, `RunReport.from`, `PairReport.from` and `TrendReport.from`, each with one options bag that chose its sections. That is a Facade: it hides which parts a page has. Ezz asked why the paper used static factories, and ruled for building blocks that the host composes.

## Decision

1. **Each kind is a building block: a class built with `new` from its input**, which gives a `Section` (core ADR 0008). `Summary`, `ValidityGap`, `Slices`, `RepeatSpread`, `CostAndLatency` and the `FieldErrors` of `./structured` take a `RunLog`. `Verdicts` and `TestsMoved` take a `RunPair`. `FieldDiff` takes a `RunLog` or a `RunPair`. `Trend` takes two runs or more, as a tuple type.
2. **`new Page(title, sections)` is the composite**, in `./report`. The host lists the sections at the call site and sees each one (Composite).
3. **The input sets when a block can be built, and the host builds it.** A page of a `RunLog` at the end of a run (promptfoo's `afterAll`); a page of a `RunPair` when both runs exist; a trend when asked. The package has no trigger of its own.
4. **No static factory.** Each part is built in memory and at once. `@zukhruf/mteb/report` has `Report.from` because it reads files, and a constructor cannot be async; no part here reads a file.

## Consequences

- A host that wants one view builds a page with one section.
- A page of more than two runs side by side is a later building block.
