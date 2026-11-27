# A page is HTML or Markdown text, in the base layer

Status: proposed (2026-11-27, #6108). Design for review: no code yet.

## Context

`@zukhruf/evals` is in the base layer (`std:base`, root ADR 0001). A UI framework, such as `@zukhruf/ui` or `@zukhruf/shadcn` (`std:ui`), would put `./report` above the base layer, and every user of `@zukhruf/evals` would install it. `@zukhruf/mteb/report` writes its page as text: one HTML string with its styles and a small script, which a browser opens as a file and an artifact on claude.ai wraps. Its tooltips and its split switch need no framework. .NET's `HtmlReportWriter` and BenchmarkDotNet's `HtmlExporter` also write one self-contained file.

## Decision

1. **`new HtmlRenderer().render(page)` gives one self-contained page as text**: no `<html>`, `<head>` or `<body>`, its styles and script inline, its fonts from Google Fonts, as mteb's page. The renderer visits each primitive (core ADR 0008).
2. **`new MarkdownRenderer().render(page)` gives the same sections as Markdown**, for a commit message, a doc or a terminal.
3. **The page shell starts as a copy of mteb's** (`styles.ts`, `script.ts`, the formatting of numbers in `page.ts`), recorded in `docs/copied-code.md`. The copy ends when mteb's report becomes `./ranking` building blocks on a `Page` (#6112).

## Consequences

- No new dependency. The page works offline but for its fonts.
- A page of many tests (offers: 307 pages, 921 answers) keeps its size with a limit on the rows of each table and of the field diff, which the host sets.
