# Information filtering packages share one folder and keep their names

Relevance filtering (#3195) is a new package. It decides which articles of a stream match a profile of the reader. Event grouping puts reports of one event into one event, and a reader (#3205) will group the accepted articles. More stages of the news engine can come: near-duplicate removal, novelty detection and ranking. Each of them is a part of information filtering, the field of the systems that select items from a stream for a person (Belkin and Croft 1992; the TREC Filtering track).

The relevance filter needs a home in this workspace. ADR 0002 put the packages about SQLite in `packages/sqlite/<concept>`, and their npm names carry `sqlite-`, because npm has no folders.

## Decision

A package whose concept is a stage of information filtering lives in `packages/information-filtering/<concept>`. Its npm name is `@zukhruf/<concept>`, and its Nx project name is `<concept>`, with no prefix for the area.

- Relevance filtering is `packages/information-filtering/relevance-filtering`, `@zukhruf/relevance-filtering`, project `relevance-filtering`.
- It is in the domain layer (`std:domain`).

The name of a stage already names its field. "Relevance filtering", "novelty detection" and "event grouping" are terms of the literature, and each one is clear alone. `@zukhruf/information-filtering-relevance-filtering` says "filtering" twice, and a reader searches npm for "relevance filtering". The name `sqlite-drift` needs its prefix, because "drift" alone does not say that it is about SQLite.

Event grouping stays in `packages/event-grouping`. It was published before this folder, and other repositories import it. A move of a module that others import is a question of cohesion, and it can occur at any time (ADR 0001, rule 3). Its npm name does not change with a move.

## Considered Options

- **A flat folder, `packages/relevance-filtering`**, as each other package. This works, but the stages of the news engine do not show as one group.
- **The folder and the prefix of ADR 0002, `@zukhruf/information-filtering-relevance`.** The prefix makes the name long, and "relevance" alone is not the concept.
- **The folder, and the name of the concept.** This option was selected.

## Consequences

- The `workspaces` field of the root `package.json` lists `packages/information-filtering/*`.
- A relative path in a package of this folder goes up three levels, for example `../../../tsconfig.base.json`.
- Lint, the Nx targets, CI and the release need no change: they select a project by its tag, or by a glob that also finds a folder in a folder.
