# A report is sections of blocks: the core holds the blocks, and `./report` renders them

Status: proposed (2026-11-27, #6108). Design for review: no code yet.

## Context

A family knows views that no other family has. `./structured` knows the errors of each field and the pairs of items; `./ranking`, later, knows the recall at each cut-off (mteb's report). The report must show those views on its page. But a subpath imports only the core (ADR 0001), so `./structured` cannot import `./report`, and `./report` cannot import `./structured`.

Two shapes were possible:

- **A family renders its own HTML.** scikit-learn's `ConfusionMatrixDisplay` draws with matplotlib itself, beside its metric. Each family would then carry the styles of the page, and the pages of two families would not look alike.
- **A family gives data, and one renderer draws it.** HELM's `presentation` builds `Table` and `Cell` values that its frontend draws; Inspect AI's `ViewerConfig` names score columns and heat shading that its viewer draws.

Ezz rejected promptfoo's viewer for how it looks (2026-11-24), so one look for every page matters.

## Decision

1. **A section is a claim and its blocks.** `Section` holds an id, the claim that is its title (report ADR 0002), and a list of blocks.
2. **A block is one of a closed set of kinds, each with only its own fields:** a table (columns and rows of cells, each cell a value with a tone), bars, a scatter (one point for each test), a line over runs, a heatmap, value pairs (the two sides of one answer, each part marked as agreeing, disagreeing, only expected or only stated), and a note. The set grows by an ADR, not by an option.
3. **The core holds `Section` and `Block`; `./report` renders every kind.** A family builds sections in its own words and never writes HTML or Markdown. `./report` draws each kind as HTML and as Markdown.
4. **A family gives its sections through `SectionSource`.** A source has `sections(log)` for one run and `pairSections(baseline, change)` for two. The host passes the sources of its family to `RunReport.from` and `PairReport.from`.

## Consequences

- The core gains types of presentation. They are data, with no rendering, so the core still imports only its own dependencies.
- mteb's views become blocks of `./ranking` when mteb runs on promptfoo (#6112): recall at each cut-off is a line, the main score of each query is a heatmap.
- A view that the blocks cannot draw is a new block kind, decided on paper.
