# Primitives are data in the core, and the renderers of `./report` visit them

Status: accepted (Ezz, 2026-11-27, #6108: "It should be primitives and building blocks"; "Renderers visit"); the primitives and `Section` are built in `src/presentation/primitives.ts`, `HtmlRenderer` and `MarkdownRenderer` of `./report` are built in `src/report/` (7043d988). Building them added three rules: a `Line` refuses a series with another number of values than its steps, a `Heatmap` refuses values of another shape, and a `ValuePairs` pair is a union by its mark, so a part that only one side has cannot hold the other side's value. The marks are the core's words, `agree`, `near`, `disagree`, `only-expected` and `only-actual`, which `./structured` names correct, partial, incorrect, missed and spurious.

## Context

A family knows views that no other family has. `./structured` knows the errors of each field and the pairs of items; `./ranking`, later, knows the recall at each cut-off (mteb's report). A page must show those views. But a subpath imports only the core (ADR 0001), so `./structured` cannot import `./report`, and `./report` cannot import `./structured`.

Two shapes were possible:

- **Each primitive draws itself** (Composite with a method for each format), as `@zukhruf/mteb`'s `DataFrame` has `toCsv`, `toMarkdown` and `toLatex`. Families build the primitives, so the primitives must be in the core, and the HTML would then be in the core too.
- **The primitives are data, and renderers visit them** (Visitor). HELM's `presentation` builds `Table` and `Cell` values that its frontend draws; Inspect AI's `ViewerConfig` names score columns and heat shading that its viewer draws.

The set of primitives is small and changes rarely; the formats grow (HTML and Markdown now). Ezz rejected promptfoo's viewer for how it looks (2026-11-24), so one look for every page matters.

## Decision

1. **The core holds the primitives as data**: `Table` (columns, and rows of cells, each a value with a tone), `Bars`, `Scatter` (one point for each test), `Line` (a value for each run), `Heatmap`, `ValuePairs` (the two sides of one answer, each part marked by its class) and `Note`. Each holds only its own fields.
2. **Each primitive has `accept(visitor)`, and `PrimitiveVisitor<R>` has one method for each primitive.** A new primitive does not compile until each renderer draws it.
3. **`./report` has the renderers**: `HtmlRenderer` and `MarkdownRenderer`, each a `PrimitiveVisitor<string>` with `render(page)`.
4. **A `Section` is a claim and its primitives**, in the core. A building block of any family is a `Section` (report ADR 0001).

## Consequences

- The core gains types of presentation. They are data, with no HTML, so the core keeps its dependencies.
- A family never writes HTML or Markdown, so its views look like every other view.
- mteb's views become primitives of `./ranking` when mteb runs on promptfoo (#6112): recall at each cut-off is a `Line`, the main score of each query a `Heatmap`.
- A view that the primitives cannot draw is a new primitive, decided on paper.
