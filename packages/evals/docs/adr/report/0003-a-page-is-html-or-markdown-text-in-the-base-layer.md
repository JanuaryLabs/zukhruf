# A page is HTML or Markdown text, in the base layer

Status: accepted (Ezz, 2026-11-27, #6108: "Renderers visit"); `Page`, `HtmlRenderer` and `MarkdownRenderer` are built in `src/report/`. Building them added points 4 and 5.

## Context

`@zukhruf/evals` is in the base layer (`std:base`, root ADR 0001). A UI framework, such as `@zukhruf/ui` or `@zukhruf/shadcn` (`std:ui`), would put `./report` above the base layer, and every user of `@zukhruf/evals` would install it. `@zukhruf/mteb/report` writes its page as text: one HTML string with its styles and a small script, which a browser opens as a file and an artifact on claude.ai wraps. Its tooltips and its split switch need no framework. .NET's `HtmlReportWriter` and BenchmarkDotNet's `HtmlExporter` also write one self-contained file.

## Decision

1. **`new HtmlRenderer().render(page)` gives one self-contained page as text**: no `<html>`, `<head>` or `<body>`, its styles and script inline, its fonts from Google Fonts, as mteb's page. The renderer visits each primitive (core ADR 0008).
2. **`new MarkdownRenderer().render(page)` gives the same sections as Markdown**, for a commit message, a doc or a terminal.
3. **The page shell starts as a copy of mteb's** (`styles.ts`, `script.ts`, the formatting of numbers in `page.ts`), recorded in `docs/copied-code.md`. The copy ends when mteb's report becomes `./ranking` building blocks on a `Page` (#6112).
4. **`MarkdownRenderer` builds a Markdown syntax tree (mdast) and writes it with remark's `mdast-util-to-markdown` and `mdast-util-gfm-table`.** Every string of a primitive comes from a page or an answer, so each one is a text node, and the writer escapes each character that would start Markdown or HTML there. A probe of nine strings (`<img src=x onerror=alert(1)>`, `![x](https://t/p.png)`, `a|b`, `back\|slash`, a line break, `5* rating`, `_and_`, a backtick, `# not a heading`) read each one back as itself; the hand-written escape of the first build, which escaped only `|`, `\` and line breaks, kept the `<img>` as HTML, made the image and the emphasis, and turned the line break into a space. A path is a text node too, not inline code: `mdast-util-gfm-table` 2.0.1 writes a `\|` and a line break inside inline code as they are, so the cell reads `|` back, or the row ends.
5. **A missing value (NaN) is drawn as missing**: a dash in a table and a tooltip, with no interval when neither end is known; an empty dashed cell in a heatmap; and a gap in a line and in its band, which start again at the next known step.

## Consequences

- The HTML page has no new dependency, and it works offline but for its fonts. The Markdown page has three optional peers, `mdast-util-to-markdown`, `mdast-util-gfm-table` and `@types/mdast` (core ADR 0001, rule 3), so a user of another import path does not install them.
- A page of many tests (offers: 307 pages, 921 answers) keeps its size with a limit on the rows of each table and of the field diff, which the host sets.
